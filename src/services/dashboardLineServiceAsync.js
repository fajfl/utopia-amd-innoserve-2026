// 「數據總攬」的 driver 版本。
//
// dashboardLineService.js 是舊的 better-sqlite3 版本,只會讀本機
// data/ecs-neo-v2.sqlite。V2_DB_DRIVER=mysql 時要走這一份,資料才會來自 TiDB。
// 入口切換在 dashboardLineService.getConfiguredDashboardLineService()。
//
// 報修單明細走 v2RepairRepositoryAsync —— 那一支只搬了明細會用到的讀取路徑,
// 所以總攬與明細讀的是同一個資料庫,不會出現「總攬讀雲端、明細讀本機」的混合狀態。
// 報修流程的寫入路徑(建單、更新、結案)仍只有 better-sqlite3 版本。

const { getDashboardOverview } = require('../repositories/v2DashboardRepositoryAsync');
const repairs = require('../repositories/v2RepairRepositoryAsync');
const presenter = require('./dashboardLinePresenter');
const { findOrCreateLineUser } = require('../repositories/v2InquiryRepositoryAsync');
const contractRepository = require('../repositories/v2ContractRepositoryAsync');
const knowledge = require('../repositories/v2LandlordKnowledgeRepositoryAsync');
const flows = require('../repositories/v2LineFlowRepositoryAsync');
const knowledgePresenter = require('./landlordKnowledgeLinePresenter');
const { isDashboardCommand, dashboardViewForText } = require('./dashboardLineService');

function textMessage(text) {
  return { handled: true, messages: [{ type: 'text', text }] };
}

function createDashboardLineServiceAsync({ db, now = () => new Date() } = {}) {
  async function withRepairFiles(item) {
    if (!item) return item;
    const publicId = item.public_id || item.publicId;
    return {
      ...item,
      files: publicId ? await repairs.listRepairFiles(db, publicId) : [],
    };
  }

  async function buildOverview(lineUserId) {
    return {
      ...(await getDashboardOverview(db, { lineUserId, now: now() })),
      lineUserId,
    };
  }

  async function handleText(input = {}) {
    if (!isDashboardCommand(input.text)) {
      return { handled: false, messages: [] };
    }
    const view = dashboardViewForText(input.text);
    if (view === 'task_menu_cancel') {
      return textMessage('已取消待辦選單。');
    }
    const overview = await buildOverview(input.lineUserId);
    if (view === 'latest_repair_detail') {
      const repairItem = await withRepairFiles((overview.repairItems || [])[0]);
      return {
        handled: true,
        messages: [
          repairItem
            ? presenter.dashboardRepairDetailCard(repairItem, overview.scope, input.lineUserId)
            : { type: 'text', text: '目前沒有可查看的報修單。' },
        ],
      };
    }
    if (view === 'repairs' || view === 'repair_process') {
      return {
        handled: true,
        messages: [presenter.dashboardSectionCard(overview, view)],
      };
    }
    if (['question_rooms', 'showings', 'inspections', 'intentions'].includes(view)) {
      return {
        handled: true,
        messages: [presenter.dashboardTaskSectionCard(overview, view)],
      };
    }
    return {
      handled: true,
      messages: [
        view === 'overview'
          ? presenter.dashboardOverviewCard(overview)
          : presenter.dashboardSectionCard(overview, view),
      ],
    };
  }

  function getIntentionDecisionContext(publicId) {
    return db.get(`
      WITH latest_versions AS (
        SELECT iv.*
        FROM intention_versions iv
        JOIN (
          SELECT rental_intention_id, MAX(version_number) AS version_number
          FROM intention_versions
          GROUP BY rental_intention_id
        ) latest
          ON latest.rental_intention_id = iv.rental_intention_id
         AND latest.version_number = iv.version_number
      )
      SELECT
        ri.id,
        ri.public_id,
        ri.status,
        ri.tenant_user_id,
        ri.inquiry_id,
        COALESCE(ru.unit_label, l.title, '房源') AS unit_label,
        lv.id AS intention_version_id,
        lv.rent_amount,
        lv.move_in_date,
        li.line_user_id AS tenant_line_user_id
      FROM rental_intentions ri
      JOIN listings l ON l.id = ri.listing_id
      JOIN rental_units ru ON ru.id = l.rental_unit_id
      LEFT JOIN latest_versions lv ON lv.rental_intention_id = ri.id
      LEFT JOIN line_identities li ON li.user_id = ri.tenant_user_id
      WHERE ri.public_id = ?
      ORDER BY li.updated_at DESC
      LIMIT 1
    `, [publicId]);
  }

  async function handleIntentionDecision(input, params) {
    const intentionPublicId = params.get('id');
    const decision = params.get('decision');
    if (!['accept', 'reject'].includes(decision)) {
      return textMessage('不支援的簽約條件操作。');
    }
    const who = await findOrCreateLineUser(db, {
      lineUserId: input.lineUserId,
      displayName: input.displayName,
    });
    const context = await getIntentionDecisionContext(intentionPublicId);
    if (!context) {
      return textMessage('找不到這筆簽約條件。');
    }
    if (['rejected', 'withdrawn', 'leased_to_another_tenant', 'ended'].includes(context.status)) {
      return textMessage(`這筆簽約條件已結束，目前狀態：${context.status}。`);
    }
    if (context.status === 'contracting') {
      return textMessage('這筆簽約條件已接受，正在簽約流程中。');
    }
    if (!context.intention_version_id) {
      return textMessage('這筆簽約條件尚未形成可決策版本。');
    }

    let contractVersion = null;
    const toStatus = decision === 'accept' ? 'contracting' : 'rejected';
    if (decision === 'accept') {
      contractVersion = await contractRepository.createVersionFromIntention(db, {
        rentalIntentionPublicId: intentionPublicId,
        actorUserId: who.userId,
      });
    }

    await db.transaction(async (tx) => {
      await tx.run(`
        INSERT INTO intention_decisions (
          rental_intention_id, intention_version_id, decision, decided_by_user_id, reason, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [
        context.id,
        context.intention_version_id,
        decision === 'accept' ? 'accepted' : 'rejected',
        who.userId,
        decision === 'accept' ? '房東接受條件，進入簽約流程' : '房東拒絕承租條件',
        now().toISOString(),
      ]);
      await tx.run(`
        INSERT INTO intention_status_history (
          rental_intention_id, from_status, to_status, actor_user_id, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [
        context.id,
        context.status,
        toStatus,
        who.userId,
        decision === 'accept' ? 'accepted_by_landlord' : 'rejected_by_landlord',
        now().toISOString(),
      ]);
      await tx.run(`
        UPDATE rental_intentions
        SET status = ?, ended_at = CASE WHEN ? = 'rejected' THEN CURRENT_TIMESTAMP ELSE ended_at END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [toStatus, toStatus, context.id]);
      if (decision === 'accept') {
        await tx.run(
          "UPDATE inquiries SET status = 'contracting', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [context.inquiry_id]
        );
      }
    });

    const tenantText = decision === 'accept'
      ? `房東已接受「${context.unit_label}」的承租條件，準備進入簽約流程。`
      : `房東已拒絕「${context.unit_label}」的承租條件；你可以再與房東討論或調整條件。`;
    if (input.lineClient && context.tenant_line_user_id && !context.tenant_line_user_id.includes('DEMO')) {
      input.lineClient.pushMessage(context.tenant_line_user_id, { type: 'text', text: tenantText })
        .catch((err) => console.error('Failed to push intention decision:', err.message));
    }

    const reply = decision === 'accept'
      ? `已接受簽約條件，並建立合約草稿 v${contractVersion.versionNumber}。系統已通知房客。`
      : '已拒絕簽約條件，系統已通知房客。';
    return textMessage(reply);
  }

  async function handlePostback(input = {}) {
    const rawData = String(input.data || '');
    const params = new URLSearchParams(rawData);
    if (params.get('action') === 'intention_decision') {
      return handleIntentionDecision(input, params);
    }
    if (rawData !== 'dashboard_view' && params.get('action') !== 'dashboard_view') {
      return { handled: false, messages: [] };
    }
    const view = params.get('view') || 'overview';
    if (view.startsWith('question_room:')) {
      const listingPublicId = view.slice('question_room:'.length);
      const who = await findOrCreateLineUser(db, {
        lineUserId: input.lineUserId,
        displayName: input.displayName,
      });
      const summary = await knowledge.getListingKnowledgeSummary(db, listingPublicId);
      const pending = await knowledge.listPendingQuestions(db, summary.id);
      if (!pending.length) {
        return textMessage('這間房目前沒有待回答問題。');
      }
      const flow = await flows.startFlow(db, {
        lineIdentityId: who.lineIdentityId,
        listingId: summary.id,
        stepCode: 'answer_question',
        context: {
          listingPublicId: summary.publicId,
          questionPublicId: pending[0].publicId,
        },
        now: now(),
      });
      await flows.advanceFlow(db, {
        publicId: flow.publicId,
        listingId: summary.id,
        stepCode: 'answer_question',
        context: {
          listingPublicId: summary.publicId,
          questionPublicId: pending[0].publicId,
        },
        now: now(),
      });
      return {
        handled: true,
        messages: [knowledgePresenter.pendingQuestionMessage(pending[0], 1, pending.length)],
      };
    }
    const overview = await buildOverview(input.lineUserId);
    if (view.startsWith('repair_detail:') || view.startsWith('repair_process:')) {
      const isRepairProcess = view.startsWith('repair_process:');
      const ticketPublicId = view.slice((isRepairProcess ? 'repair_process:' : 'repair_detail:').length);
      const who = await findOrCreateLineUser(db, {
        lineUserId: input.lineUserId,
        displayName: input.displayName,
      });
      const item = await withRepairFiles(await repairs.getRepairContext(db, ticketPublicId));
      if (!item) {
        return textMessage('找不到這張報修單。');
      }
      const allowDemoAction = (
        (params.get('scope') === 'demo_all' || overview.scope === 'demo_all')
        && process.env.NODE_ENV !== 'production'
      );
      if (!allowDemoAction && !(await repairs.canManageRepairTicket(db, ticketPublicId, who.userId))) {
        return textMessage('你沒有這張報修單的查看權限。');
      }
      return {
        handled: true,
        messages: [presenter.dashboardRepairDetailCard(item, overview.scope, input.lineUserId)],
      };
    }
    if (view === 'task_menu_cancel' || view === 'history_cancel') {
      return textMessage('已關閉選單。');
    }
    if (view === 'task_menu') {
      return {
        handled: true,
        messages: [presenter.dashboardSectionCard(overview, 'tasks')],
      };
    }
    if (view === 'repairs' || view === 'repair_process') {
      return {
        handled: true,
        messages: [presenter.dashboardSectionCard(overview, view)],
      };
    }
    if (['question_rooms', 'showings', 'inspections', 'intentions'].includes(view)) {
      return {
        handled: true,
        messages: [presenter.dashboardTaskSectionCard(overview, view)],
      };
    }
    if (view === 'history' || view.startsWith('history:')) {
      return {
        handled: true,
        messages: [presenter.dashboardSectionCard(overview, 'latest')],
      };
    }
    return {
      handled: true,
      messages: [presenter.dashboardSectionCard(overview, view)],
    };
  }

  return { handleText, handlePostback };
}

const { withV2Driver } = require('../database/v2Driver');

// 每次呼叫各自借一條連線,用完歸還 —— 和其他 driver 版服務一致。
function getConfiguredDashboardLineServiceAsync() {
  const call = (method) => (input) => withV2Driver(
    (db) => createDashboardLineServiceAsync({ db })[method](input)
  );
  return { handleText: call('handleText'), handlePostback: call('handlePostback') };
}

module.exports = {
  createDashboardLineServiceAsync,
  getConfiguredDashboardLineServiceAsync,
  isDashboardCommand,
};
