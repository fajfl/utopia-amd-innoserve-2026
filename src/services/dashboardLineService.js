const path = require('node:path');
const { openV2Database } = require('../database/v2Database');
const { getDashboardOverview } = require('../repositories/v2DashboardRepository');
const presenter = require('./dashboardLinePresenter');
const { findOrCreateLineUser } = require('../repositories/v2InquiryRepository');
const contractRepository = require('../repositories/v2ContractRepository');
const knowledge = require('../repositories/v2LandlordKnowledgeRepository');
const flows = require('../repositories/v2LineFlowRepository');
const knowledgePresenter = require('./landlordKnowledgeLinePresenter');
const repairs = require('../repositories/v2RepairRepository');

const DASHBOARD_TEXTS = new Set([
  '數據總覽',
  '數據總攬',
  '報表分析',
  'dashboard',
  'Dashboard',
]);

const TASK_TEXTS = new Set([
  '通知中心',
  '待辦',
  '待辦事項',
  '今日待辦',
  '代辦',
  '代辦/修繕',
  '待辦/修繕',
  '通知與待辦事項',
  '通知與待辦',
  '通知與代辦事項',
  '通知與代辦',
]);

const REPAIR_TEXTS = new Set([
  '查看報修',
  '房客報修',
  '報修',
  '修繕',
]);

const REPAIR_DETAIL_TEXTS = new Set([
  '詳情',
  '報修詳情',
  '查看詳情',
]);

const TASK_CATEGORY_TEXT_VIEWS = new Map([
  ['問題', 'question_rooms'],
  ['看房', 'showings'],
  ['點交', 'inspections'],
  ['簽約', 'intentions'],
  ['條件', 'intentions'],
  ['修繕', 'repairs'],
  ['取消', 'task_menu_cancel'],
]);

function isDashboardCommand(text) {
  const normalized = String(text || '').trim();
  return DASHBOARD_TEXTS.has(normalized)
    || TASK_TEXTS.has(normalized)
    || REPAIR_TEXTS.has(normalized)
    || REPAIR_DETAIL_TEXTS.has(normalized)
    || TASK_CATEGORY_TEXT_VIEWS.has(normalized);
}

function dashboardViewForText(text) {
  const normalized = String(text || '').trim();
  if (TASK_CATEGORY_TEXT_VIEWS.has(normalized)) return TASK_CATEGORY_TEXT_VIEWS.get(normalized);
  if (REPAIR_DETAIL_TEXTS.has(normalized)) return 'latest_repair_detail';
  if (REPAIR_TEXTS.has(normalized)) return 'repairs';
  if (TASK_TEXTS.has(normalized)) return 'tasks';
  return 'overview';
}

function createDashboardLineService({ db, now = () => new Date() } = {}) {
  function buildOverview(lineUserId) {
    return {
      ...getDashboardOverview(db, {
      lineUserId,
      now: now(),
      }),
      lineUserId,
    };
  }

  function withRepairFiles(item) {
    if (!item) return item;
    const publicId = item.public_id || item.publicId;
    return {
      ...item,
      files: publicId ? repairs.listRepairFiles(db, publicId) : [],
    };
  }

  function handleText(input = {}) {
    if (!isDashboardCommand(input.text)) {
      return { handled: false, messages: [] };
    }
    const overview = buildOverview(input.lineUserId);
    const view = dashboardViewForText(input.text);
    if (view === 'latest_repair_detail') {
      const repairItem = withRepairFiles((overview.repairItems || [])[0]);
      return {
        handled: true,
        messages: [
          repairItem
            ? presenter.dashboardRepairDetailCard(repairItem, overview.scope, input.lineUserId)
            : { type: 'text', text: '目前沒有可查看的報修單。' },
        ],
      };
    }
    if (view === 'task_menu_cancel') {
      return {
        handled: true,
        messages: [{ type: 'text', text: '已取消待辦選單。' }],
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
    return db.prepare(`
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
    `).get(publicId);
  }

  async function handleIntentionDecision(input, params) {
    const intentionPublicId = params.get('id');
    const decision = params.get('decision');
    if (!['accept', 'reject'].includes(decision)) {
      return { handled: true, messages: [{ type: 'text', text: '不支援的簽約條件操作。' }] };
    }
    const who = findOrCreateLineUser(db, {
      lineUserId: input.lineUserId,
      displayName: input.displayName,
    });
    const context = getIntentionDecisionContext(intentionPublicId);
    if (!context) {
      return { handled: true, messages: [{ type: 'text', text: '找不到這筆簽約條件。' }] };
    }
    if (['rejected', 'withdrawn', 'leased_to_another_tenant', 'ended'].includes(context.status)) {
      return { handled: true, messages: [{ type: 'text', text: `這筆簽約條件已結束，目前狀態：${context.status}。` }] };
    }
    if (context.status === 'contracting') {
      return { handled: true, messages: [{ type: 'text', text: '這筆簽約條件已接受，正在簽約流程中。' }] };
    }
    if (!context.intention_version_id) {
      return { handled: true, messages: [{ type: 'text', text: '這筆簽約條件尚未形成可決策版本。' }] };
    }

    let contractVersion = null;
    const toStatus = decision === 'accept' ? 'contracting' : 'rejected';
    if (decision === 'accept') {
      contractVersion = contractRepository.createVersionFromIntention(db, {
        rentalIntentionPublicId: intentionPublicId,
        actorUserId: who.userId,
      });
    }

    db.transaction(() => {
      db.prepare(`
        INSERT INTO intention_decisions (
          rental_intention_id, intention_version_id, decision, decided_by_user_id, reason, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        context.id,
        context.intention_version_id,
        decision === 'accept' ? 'accepted' : 'rejected',
        who.userId,
        decision === 'accept' ? '房東接受條件，進入簽約流程' : '房東拒絕承租條件',
        now().toISOString(),
      );
      db.prepare(`
        INSERT INTO intention_status_history (
          rental_intention_id, from_status, to_status, actor_user_id, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        context.id,
        context.status,
        toStatus,
        who.userId,
        decision === 'accept' ? 'accepted_by_landlord' : 'rejected_by_landlord',
        now().toISOString(),
      );
      db.prepare(`
        UPDATE rental_intentions
        SET status = ?, ended_at = CASE WHEN ? = 'rejected' THEN CURRENT_TIMESTAMP ELSE ended_at END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(toStatus, toStatus, context.id);
      if (decision === 'accept') {
        db.prepare("UPDATE inquiries SET status = 'contracting', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(context.inquiry_id);
      }
    }).immediate();

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
    return { handled: true, messages: [{ type: 'text', text: reply }] };
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
      const who = findOrCreateLineUser(db, {
        lineUserId: input.lineUserId,
        displayName: input.displayName,
      });
      const summary = knowledge.getListingKnowledgeSummary(db, listingPublicId);
      const pending = knowledge.listPendingQuestions(db, summary.id);
      if (!pending.length) {
        return { handled: true, messages: [{ type: 'text', text: '這間房目前沒有待回答問題。' }] };
      }
      const flow = flows.startFlow(db, {
        lineIdentityId: who.lineIdentityId,
        listingId: summary.id,
        stepCode: 'answer_question',
        context: {
          listingPublicId: summary.publicId,
          questionPublicId: pending[0].publicId,
        },
        now: now(),
      });
      flows.advanceFlow(db, {
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
    const overview = buildOverview(input.lineUserId);
    if (view.startsWith('repair_detail:') || view.startsWith('repair_process:')) {
      const isRepairProcess = view.startsWith('repair_process:');
      const ticketPublicId = view.slice((isRepairProcess ? 'repair_process:' : 'repair_detail:').length);
      const who = findOrCreateLineUser(db, {
        lineUserId: input.lineUserId,
        displayName: input.displayName,
      });
      const item = withRepairFiles(repairs.getRepairContext(db, ticketPublicId));
      if (!item) {
        return { handled: true, messages: [{ type: 'text', text: '找不到這張報修單。' }] };
      }
      const allowDemoAction = (
        (params.get('scope') === 'demo_all' || overview.scope === 'demo_all')
        && process.env.NODE_ENV !== 'production'
      );
      if (!allowDemoAction && !repairs.canManageRepairTicket(db, ticketPublicId, who.userId)) {
        return { handled: true, messages: [{ type: 'text', text: '你沒有這張報修單的查看權限。' }] };
      }
      return {
        handled: true,
        messages: [presenter.dashboardRepairDetailCard(item, overview.scope, input.lineUserId)],
      };
    }
    if (view === 'task_menu_cancel' || view === 'history_cancel') {
      return {
        handled: true,
        messages: [{ type: 'text', text: '已關閉選單。' }],
      };
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

let runtime;

function driverMode() {
  return String(process.env.V2_DB_DRIVER || 'sqlite').trim().toLowerCase();
}

// 入口要跟著 V2_DB_DRIVER 走。這裡以前無條件開本機 SQLite,於是 mysql 模式下
// 資料寫在 TiDB、數據總攬卻讀本機檔案,畫面會是空的或過期的。
//
// 兩個 runtime 的 handleText / handlePostback 都回 Promise(sqlite 版的
// handleText 是同步函式,但呼叫端本來就 await),所以呼叫端不需要改。
function getConfiguredDashboardLineService() {
  if (driverMode() === 'mysql') {
    // 延後 require:driver 版反過來要用這裡的文字指令對照表,寫在最上面會變成
    // 循環相依。
    return require('./dashboardLineServiceAsync').getConfiguredDashboardLineServiceAsync();
  }
  if (!runtime) {
    const db = openV2Database({
      dbPath: process.env.V2_DATABASE_PATH || path.join(__dirname, '..', '..', 'data', 'ecs-neo-v2.sqlite'),
    });
    runtime = createDashboardLineService({ db });
  }
  return runtime;
}

module.exports = {
  createDashboardLineService,
  getConfiguredDashboardLineService,
  isDashboardCommand,
  dashboardViewForText,
};
