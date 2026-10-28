// 合約通知 service 的 driver 版本。參數 `db` 收的是 sqlDriver 的 driver。

const crypto = require('node:crypto');
const { buildLandlordDecisionMessage, landlordDecisionText } = require('./v2ContractNotificationService');
const { enqueueNotification } = require('./ecsNeoOutboxAsync');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// 去重靠 channel_events 的 (provider, provider_event_id) 唯一索引:先寫入,寫得進去
// 才真的送出。刻意**不包在交易裡** —— 交易期間不做外部呼叫,LINE 一慢就會把
// 資料庫的寫鎖佔住。送出失敗時再把去重列刪掉,讓下次重試還能送。
async function pushOnce({ db, lineClient, recipient, lineIdentityId, userId, eventId, eventType, payload, actionUrl = '' }) {
  const raw = JSON.stringify(payload);
  const inserted = await db.run(`${db.dialect.insertIgnore} INTO channel_events
    (public_id,provider,provider_event_id,event_type,line_identity_id,user_id,received_at,processed_at,processing_status,raw_payload_json,raw_hash)
    VALUES (?,'line',?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'processed',?,?)`,
  [`channel-event-${crypto.randomUUID()}`, eventId, eventType, lineIdentityId, userId, raw, sha256(raw)]);
  if (!inserted.changes) return { sent: false, duplicate: true };
  try {
    await enqueueNotification(db, {
      eventType,
      entityType: 'contract_event',
      entityId: eventId,
      payload: {
        title: eventType.includes('tenant_signed') ? '房客已簽署合約' : '簽約流程通知',
        message: payload && payload.text ? payload.text : '合約狀態已更新，請查看後續處理。',
        contractEventId: eventId,
        actionUrl
      },
      recipients: [{ role: 'recipient', userId }],
      idempotencyKey: `contract_notification:${eventId}`
    });
  } catch (notificationError) {
    console.error('Failed to record contract notification:', notificationError.message);
  }
  try {
    await lineClient.pushMessage(recipient, payload);
    return { sent: true, duplicate: false };
  } catch (error) {
    await db.run("DELETE FROM channel_events WHERE provider='line' AND provider_event_id=?", [eventId]);
    throw error;
  }
}

async function notifyLandlordTenantSigned({ db, lineClient, contractPublicId, versionPublicId }) {
  const row = await db.get(`
    SELECT c.public_id contract_public_id, cv.version_number, p.address_text, ru.unit_label,
           tenant_record.public_id tenant_record_public_id, tenant_record.signed_at,
           COALESCE(tenant_snapshot.legal_name, tenant_line.display_name_cache, '房客') tenant_name,
           landlord_request.public_id landlord_request_public_id,
           landlord_line.id landlord_line_identity_id, landlord_line.user_id landlord_user_id,
           landlord_line.line_user_id landlord_line_user_id
    FROM contracts c
    JOIN contract_versions cv ON cv.contract_id=c.id AND cv.public_id=?
    JOIN rental_units ru ON ru.id=c.rental_unit_id JOIN properties p ON p.id=ru.property_id
    JOIN contract_parties tenant_party ON tenant_party.contract_id=c.id AND tenant_party.party_role='tenant'
    LEFT JOIN line_identities tenant_line ON tenant_line.user_id=tenant_party.user_id
    JOIN signature_records tenant_record ON tenant_record.contract_version_id=cv.id AND tenant_record.contract_party_id=tenant_party.id
    LEFT JOIN contract_party_snapshots tenant_snapshot ON tenant_snapshot.contract_party_id=tenant_party.id AND tenant_snapshot.contract_version_id=cv.id
    JOIN contract_parties landlord_party ON landlord_party.contract_id=c.id AND landlord_party.party_role='landlord'
    JOIN signature_requests landlord_request ON landlord_request.contract_version_id=cv.id AND landlord_request.contract_party_id=landlord_party.id
    JOIN line_identities landlord_line ON landlord_line.user_id=landlord_party.user_id
    WHERE c.public_id=?
  `, [versionPublicId, contractPublicId]);
  if (!row) throw new Error('tenant-signed contract notification context not found');
  const payload = buildLandlordDecisionMessage({ propertyLabel: `${row.address_text} ${row.unit_label}`, tenantName: row.tenant_name, versionNumber: row.version_number, signedAt: row.signed_at, landlordRequestPublicId: row.landlord_request_public_id });
  return pushOnce({
    db, lineClient, recipient: row.landlord_line_user_id, lineIdentityId: row.landlord_line_identity_id,
    userId: row.landlord_user_id, eventId: `contract-tenant-signed:${row.tenant_record_public_id}`,
    eventType: 'contract_tenant_signed_notification', payload,
    actionUrl: `/v2/sign/${encodeURIComponent(row.landlord_request_public_id)}?lineUserId=${encodeURIComponent(row.landlord_line_user_id)}`
  });
}

async function notifyTenantLandlordDecision({ db, lineClient, contractPublicId, decision, reason }) {
  const row = await db.get("SELECT li.id line_identity_id,li.user_id,li.line_user_id,p.address_text,ru.unit_label FROM contracts c JOIN rental_units ru ON ru.id=c.rental_unit_id JOIN properties p ON p.id=ru.property_id JOIN contract_parties cp ON cp.contract_id=c.id AND cp.party_role='tenant' JOIN line_identities li ON li.user_id=cp.user_id WHERE c.public_id=?", [contractPublicId]);
  if (!row) throw new Error('tenant notification context not found');
  const payload = { type: 'text', text: landlordDecisionText({ decision, reason, propertyLabel: `${row.address_text} ${row.unit_label}` }) };
  return pushOnce({
    db, lineClient, recipient: row.line_user_id, lineIdentityId: row.line_identity_id, userId: row.user_id,
    eventId: `contract-landlord-${decision}:${contractPublicId}`, eventType: `contract_landlord_${decision}_notification`, payload,
    actionUrl: `/v2/contracts/${encodeURIComponent(contractPublicId)}/${decision === 'sign' ? 'completed' : 'drafts'}?lineUserId=${encodeURIComponent(row.line_user_id)}`
  });
}

// 房客按下送簽、但房東還沒確認條件時,把請求推給房東。
// 去重 key 綁版本:同一版重按送簽只推一次,產生新版本才會有新的一則。
async function notifyLandlordTermsConfirmationRequested({ db, lineClient, versionPublicId }) {
  const row = await db.get(`
    SELECT c.public_id contract_public_id, cv.version_number, p.address_text, ru.unit_label,
           li.id line_identity_id, li.user_id, li.line_user_id
    FROM contract_versions cv
    JOIN contracts c ON c.id=cv.contract_id
    JOIN rental_units ru ON ru.id=c.rental_unit_id JOIN properties p ON p.id=ru.property_id
    JOIN contract_parties cp ON cp.contract_id=c.id AND cp.party_role='landlord' AND cp.status='active'
    JOIN line_identities li ON li.user_id=cp.user_id
    WHERE cv.public_id=?
  `, [versionPublicId]);
  if (!row) throw new Error('landlord terms notification context not found');
  const payload = {
    type: 'text',
    text: `房客想以第 ${row.version_number} 版簽署 ${row.address_text} ${row.unit_label} 的合約，`
      + '請先確認條件（租金、押金、租期與責任條款）。\n'
      + `確認或要求修改：/v2/contracts/${row.contract_public_id}/drafts`
  };
  return pushOnce({
    db, lineClient, recipient: row.line_user_id, lineIdentityId: row.line_identity_id, userId: row.user_id,
    eventId: `contract-terms-confirmation-requested:${versionPublicId}`,
    eventType: 'contract_terms_confirmation_requested', payload,
    actionUrl: `/v2/contracts/${encodeURIComponent(row.contract_public_id)}/drafts?lineUserId=${encodeURIComponent(row.line_user_id)}`
  });
}

// 房東做完決定之後告訴房客。confirm 之後房客才有東西可按。
async function notifyTenantTermsDecision({ db, lineClient, versionPublicId, decision, reason }) {
  const row = await db.get(`
    SELECT c.public_id contract_public_id, cv.version_number, p.address_text, ru.unit_label,
           li.id line_identity_id, li.user_id, li.line_user_id
    FROM contract_versions cv
    JOIN contracts c ON c.id=cv.contract_id
    JOIN rental_units ru ON ru.id=c.rental_unit_id JOIN properties p ON p.id=ru.property_id
    JOIN contract_parties cp ON cp.contract_id=c.id AND cp.party_role='tenant' AND cp.status='active'
    JOIN line_identities li ON li.user_id=cp.user_id
    WHERE cv.public_id=?
  `, [versionPublicId]);
  if (!row) throw new Error('tenant terms notification context not found');
  const property = `${row.address_text} ${row.unit_label}`;
  const payload = {
    type: 'text',
    text: decision === 'confirm'
      ? `房東已確認 ${property} 第 ${row.version_number} 版的條件，你可以回合約頁送出簽署了。`
      : `房東對 ${property} 第 ${row.version_number} 版的條件想再調整，請回 LINE 與 Agent 討論新的版本。`
        + (typeof reason === 'string' && reason.trim() ? `
房東寫的理由：${reason.trim()}` : '')
  };
  return pushOnce({
    db, lineClient, recipient: row.line_user_id, lineIdentityId: row.line_identity_id, userId: row.user_id,
    eventId: `contract-terms-${decision}:${versionPublicId}`,
    eventType: `contract_terms_${decision}_notification`, payload,
    actionUrl: `/v2/contracts/${encodeURIComponent(row.contract_public_id)}/drafts?lineUserId=${encodeURIComponent(row.line_user_id)}`
  });
}

module.exports = {
  buildLandlordDecisionMessage,
  landlordDecisionText,
  notifyLandlordTenantSigned,
  notifyLandlordTermsConfirmationRequested,
  notifyTenantLandlordDecision,
  notifyTenantTermsDecision
};
