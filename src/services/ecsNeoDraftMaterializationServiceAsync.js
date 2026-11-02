// Materialise a tenant-confirmed, already validated prepared artifact into a
// normal contract draft.  This deliberately does not make a landlord decision
// and, importantly, does not touch rental_unit_contracting_claims.  A unit is
// only claimed from the landlord's final signature transaction.
const crypto = require('node:crypto');
const { preparedDraftChecksum, contractConditionSnapshot } = require('./ecsNeoContractAcceptanceServiceAsync');
const conditionService = require('./v2ContractConditionServiceAsync');
const { enqueueNotification } = require('./ecsNeoOutboxAsync');

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
function fail(message, code, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
function objectJson(value, label) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed;
  } catch {
    throw fail(`${label} 不是合法物件 JSON`, 'invalid_prepared_draft');
  }
}
function json(value, label) {
  try { return JSON.parse(value); } catch { throw fail(`${label} 不是合法 JSON`, 'invalid_prepared_draft'); }
}

async function materializeConfirmedIntentionDraft({ db, lineUserId, intentionVersionPublicId, preparedDraftPublicId }) {
  if (!db?.transaction) throw fail('db driver is required', 'invalid_input', 400);
  if (![lineUserId, intentionVersionPublicId, preparedDraftPublicId].every((value) => typeof value === 'string' && value.trim())) {
    throw fail('lineUserId, intentionVersionPublicId and preparedDraftPublicId are required', 'invalid_input', 400);
  }

  return db.transaction(async (tx) => {
    const actor = await tx.get(`SELECT u.id user_id FROM line_identities li JOIN users u ON u.id=li.user_id
      WHERE li.line_user_id=? AND u.status='active'`, [lineUserId]);
    if (!actor) throw fail('LINE 身分不存在或已停用', 'authorization_denied', 403);
    const version = await tx.get(`SELECT iv.id intention_version_id,iv.public_id intention_version_public_id,iv.rental_intention_id,
      ri.confirmed_intention_version_id,ri.tenant_user_id,ri.inquiry_id,ri.status intention_status,
      l.rental_unit_id FROM intention_versions iv JOIN rental_intentions ri ON ri.id=iv.rental_intention_id
      JOIN listings l ON l.id=ri.listing_id WHERE iv.public_id=?`, [intentionVersionPublicId]);
    if (!version || !sameId(version.tenant_user_id, actor.user_id)) throw fail('無權固化這份草稿', 'authorization_denied', 403);
    if (!sameId(version.confirmed_intention_version_id, version.intention_version_id)) throw fail('這不是房客已確認的意向版本', 'stale_version');
    if (['rejected', 'withdrawn', 'leased_to_another_tenant', 'ended'].includes(version.intention_status)) throw fail('這筆意向已結束', 'stale_version');

    const draft = await tx.get(`SELECT p.*,ctv.manifest_checksum,ctv.manifest_json,ctv.public_id template_public_id,ctv.source_checksum template_source_checksum,ctv.status template_status,lrpv.rules_checksum,lrpv.rules_json,lrpv.public_id rules_public_id,lrpv.status rule_pack_status
      FROM prepared_contract_drafts p JOIN contract_template_versions ctv ON ctv.id=p.contract_template_version_id
      JOIN legal_rule_pack_versions lrpv ON lrpv.id=p.legal_rule_pack_version_id WHERE p.public_id=?`, [preparedDraftPublicId]);
    if (!draft || !sameId(draft.intention_version_id, version.intention_version_id) || !sameId(draft.rental_intention_id, version.rental_intention_id)) {
      throw fail('草稿 artifact 不屬於這個意向版本', 'stale_version');
    }
    if (draft.status !== 'ready' || Number(draft.blocking_issue_count) !== 0 || draft.template_status !== 'active' || draft.rule_pack_status !== 'active') {
      throw fail('草稿 artifact 尚未通過審閱', 'draft_review_required');
    }
    const clauses = objectJson(draft.clause_snapshot_json, 'clause_snapshot_json');
    const sourceMap = objectJson(draft.source_map_json, 'source_map_json');
    const responsibilityMatrix = json(draft.responsibility_matrix_json, 'responsibility_matrix_json');
    const issues = json(draft.issues_json, 'issues_json');
    const checksum = preparedDraftChecksum({ intentionVersionPublicId: version.intention_version_public_id,
      templateManifestChecksum: draft.manifest_checksum, rulePackChecksum: draft.rules_checksum,
      modelId: draft.model_id, modelVersion: draft.model_version, promptVersion: draft.prompt_version,
      clauseSnapshot: clauses, responsibilityMatrix, issues, sourceMap });
    if (checksum !== draft.payload_checksum || !Object.keys(clauses).length || Object.keys(clauses).some((key) => !sourceMap[key] || (Array.isArray(sourceMap[key]) && !sourceMap[key].length))) {
      throw fail('草稿 artifact 的內容或來源不完整', 'invalid_prepared_draft');
    }
    if (draft.materialized_contract_version_id != null) {
      const existing = await tx.get(`SELECT cv.public_id version_public_id,c.public_id contract_public_id FROM contract_versions cv JOIN contracts c ON c.id=cv.contract_id WHERE cv.id=?`, [draft.materialized_contract_version_id]);
      if (!existing) throw fail('草稿 artifact 固化鏈不完整', 'internal_invariant_violation', 500);
      const attached = await tx.get(
        'SELECT COUNT(*) AS n FROM contract_condition_attachments WHERE contract_version_id=?',
        [draft.materialized_contract_version_id]
      );
      return {
        replayed: true,
        preparedDraftPublicId,
        contractPublicId: existing.contract_public_id,
        versionPublicId: existing.version_public_id,
        conditionRecordAttached: Number(attached.n) > 0
      };
    }

    let contract = await tx.get(`SELECT * FROM contracts WHERE selected_intention_id=? AND status IN ('drafting','awaiting_confirmation','signing') ORDER BY id DESC LIMIT 1`, [version.rental_intention_id]);
    if (!contract) {
      const inserted = await tx.run(`INSERT INTO contracts (public_id,rental_unit_id,selected_intention_id,source_inquiry_id,status) VALUES (?,?,?,?, 'drafting')`,
        [`contract-${crypto.randomUUID()}`, version.rental_unit_id, version.rental_intention_id, version.inquiry_id]);
      contract = await tx.get('SELECT * FROM contracts WHERE id=?', [inserted.insertId]);
      await tx.run(`INSERT INTO contract_status_history (contract_id,from_status,to_status,actor_user_id,reason) VALUES (?,NULL,'drafting',?,'房客確認條件後建立草稿')`, [contract.id, actor.user_id]);
    }

    // 沿用到的合約必須是同一個房源。
    //
    // schema 上一筆意向只掛一個 listing、一個 rental unit,所以正常情況撞不到。
    // 會撞到的是髒資料:demo seed、手改過的測試庫、上一輪半途失敗留下的殼。
    // 不擋的話,A 房的條件會長成 B 房的合約版本 —— 而且因為草稿內容是對的,
    // 一路到簽署都不會有人發現。寧可停在這裡要人去看那筆資料。
    if (!sameId(contract.rental_unit_id, version.rental_unit_id)) {
      throw fail('既有合約的房源與這筆意向不一致', 'internal_invariant_violation', 500);
    }

    // 兩個必要當事人一定要在，**沿用既有合約時也一樣**。
    //
    // 原本只有新建合約才寫 contract_parties。可是這個查詢會沿用任何一份已經掛著
    // 同一筆意向、還沒結束的合約 —— 舊資料、demo seed、上一輪半途失敗留下的殼，
    // 都可能是一份「沒有任何當事人」的合約。沿用它就會產生一份**誰都碰不到**的草稿:
    // requireVersionParty 找不到當事人，房客與房東都只拿得到一句 forbidden，
    // 而且看不出少了什麼。實測就撞到這個(demo 合約有 selected_intention 但沒有 parties)。
    //
    // 只補「這個角色完全沒有 active 當事人」的情況。已經有人但換了人，是所有權層面的
    // 問題，不該由固化草稿這一步偷偷改。
    for (const party of [
      { role: 'tenant', userId: version.tenant_user_id, order: 1 },
      { role: 'landlord', userId: null, order: 2 }
    ]) {
      const existing = await tx.get(
        "SELECT id FROM contract_parties WHERE contract_id=? AND party_role=? AND status='active' LIMIT 1",
        [contract.id, party.role]
      );
      if (existing) continue;
      let userId = party.userId;
      if (party.role === 'landlord') {
        const owner = await tx.get(`SELECT po.owner_user_id FROM property_owners po JOIN rental_units ru ON ru.property_id=po.property_id
          WHERE ru.id=? AND (po.rental_unit_id IS NULL OR po.rental_unit_id=ru.id)
            AND po.effective_from <= ? AND (po.effective_until IS NULL OR po.effective_until >= ?)
          ORDER BY po.rental_unit_id DESC,po.id DESC LIMIT 1`, [contract.rental_unit_id, `${new Date().toISOString().slice(0, 10)}T23:59:59.999Z`, new Date().toISOString().slice(0, 10)]);
        if (!owner) throw fail('找不到目前有效房東，無法建立草稿', 'authorization_denied', 403);
        userId = owner.owner_user_id;
      }
      await tx.run(`INSERT INTO contract_parties (public_id,contract_id,user_id,party_role,required_signer,signing_order,status) VALUES (?,?,?,?,1,?,'active')`,
        [`party-${crypto.randomUUID()}`, contract.id, userId, party.role, party.order]);
    }
    const contractSnapshot = contractConditionSnapshot(draft);
    const next = await tx.get('SELECT COALESCE(MAX(version_number),0)+1 number FROM contract_versions WHERE contract_id=?', [contract.id]);
    const inserted = await tx.run(`INSERT INTO contract_versions (public_id,contract_id,version_number,condition_snapshot_json,status,created_by_user_id) VALUES (?,?,?,?, 'draft',?)`,
      [`contract-version-${crypto.randomUUID()}`, contract.id, Number(next.number), JSON.stringify(contractSnapshot), actor.user_id]);
    for (const fieldPath of Object.keys(clauses)) await tx.run(`INSERT INTO contract_version_sources (contract_version_id,field_path,source_type,source_id) VALUES (?,?,'intention_version',?)`, [inserted.insertId, fieldPath, version.intention_version_id]);
    await tx.run('UPDATE prepared_contract_drafts SET materialized_contract_version_id=? WHERE id=? AND materialized_contract_version_id IS NULL', [inserted.insertId, draft.id]);
    const bound = await tx.get('SELECT materialized_contract_version_id FROM prepared_contract_drafts WHERE id=?', [draft.id]);
    if (!sameId(bound.materialized_contract_version_id, inserted.insertId)) throw fail('草稿已由另一請求固化', 'prepared_draft_already_materialized');

    // 附件一(屋況點交紀錄)在**同一個交易**內自動帶入。
    // 沒有可用紀錄不是錯誤:房客本來就可能還沒做點交。草稿照樣可以送出,
    // 但下面的 conditionRecordAttached=false 會讓合約頁明白寫出「本合約未附屋況紀錄」,
    // 不是靜默省略。真正擋人的是送簽時的 assertAttachmentsConfirmed ——
    // 附了、但房東還沒確認的紀錄不可以進到簽署。
    const attachment = await conditionService.autoAttachLatestRecord(tx, {
      contractId: contract.id,
      contractVersionId: inserted.insertId,
      actorUserId: actor.user_id
    });

    const createdVersion = await tx.get('SELECT public_id FROM contract_versions WHERE id=?', [inserted.insertId]);

    // durable outbox。commit 之後才由 dispatcher 推播;交易內推播失敗會把
    // 已經成立的草稿一起回滾。
    const landlord = await tx.get(
      "SELECT user_id FROM contract_parties WHERE contract_id=? AND party_role='landlord' AND status='active' ORDER BY id LIMIT 1",
      [contract.id]
    );
    await enqueueNotification(tx, {
      eventType: 'contract_draft_created',
      entityType: 'contract_version',
      entityId: inserted.insertId,
      payload: {
        contractPublicId: contract.public_id,
        versionPublicId: createdVersion.public_id,
        preparedDraftPublicId,
        conditionRecordAttached: Boolean(attachment.attached)
      },
      recipients: [
        { role: 'tenant', userId: version.tenant_user_id },
        ...(landlord ? [{ role: 'landlord', userId: landlord.user_id }] : [])
      ],
      idempotencyKey: `contract-draft:${createdVersion.public_id}`
    });

    return {
      replayed: false,
      preparedDraftPublicId,
      contractPublicId: contract.public_id,
      versionPublicId: createdVersion.public_id,
      conditionRecordAttached: Boolean(attachment.attached)
    };
  });
}

module.exports = { materializeConfirmedIntentionDraft };
