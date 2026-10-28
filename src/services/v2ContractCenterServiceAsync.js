const repository = require('../repositories/v2ContractRepositoryAsync');

const ACTIVE_CONTRACT_STATUSES = new Set(['drafting', 'awaiting_confirmation', 'signing']);
const OPEN_REQUEST_STATUSES = new Set(['pending', 'sent', 'viewed']);

function parseConditions(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function subjectLabel(row) {
  const address = String(row.addressText || '').trim();
  const unit = String(row.unitLabel || '').trim();
  if (address && unit) return `${address}・${unit}`;
  return address || row.buildingName || row.listingTitle || unit || '租賃合約';
}

function stageFor(contract, latest, signedRoles) {
  if (contract.status === 'executed') return 4;
  if (!latest) return 0;
  if (latest.status !== 'issued') return 1;
  if (signedRoles.has('tenant')) return 3;
  return 2;
}

function requestForRole(requests, role) {
  return requests.find((row) => row.partyRole === role) || null;
}

function activeRequest(request) {
  return request && OPEN_REQUEST_STATUSES.has(request.status);
}

function deriveState({ contract, latest, roles, requests, signedRoles }) {
  const roleSet = new Set(roles);
  const draftUrl = `/v2/contracts/${encodeURIComponent(contract.contractPublicId)}/drafts`;
  const tenantRequest = requestForRole(requests, 'tenant');
  const landlordRequest = requestForRole(requests, 'landlord');
  const tenantSigned = signedRoles.has('tenant');
  const landlordSigned = signedRoles.has('landlord');

  if (contract.status === 'executed') {
    return {
      statusLabel: '已完成', tone: 'done', headline: '雙方已完成簽署',
      detail: '合約已成立，可回看最終版本與附件。', action: { label: '查看合約', url: `/v2/contracts/${encodeURIComponent(contract.contractPublicId)}/completed` }, needsAttention: false
    };
  }
  if (contract.status === 'cancelled') {
    return {
      statusLabel: '已取消', tone: 'stop', headline: '這份合約已取消',
      detail: '保留既有版本供你回看。', action: { label: '查看紀錄', url: draftUrl }, needsAttention: false
    };
  }
  if (contract.status === 'superseded') {
    return {
      statusLabel: '已被取代', tone: 'neutral', headline: '已有較新的合約版本',
      detail: '這份紀錄維持唯讀。', action: { label: '查看紀錄', url: draftUrl }, needsAttention: false
    };
  }
  if (!latest) {
    return {
      statusLabel: '協商中', tone: 'neutral', headline: '正在整理合約條件',
      detail: '條件確認後會產生第一版草稿。', action: null, needsAttention: false
    };
  }
  if (latest.status === 'draft') {
    if (roleSet.has('landlord') && !latest.landlordTermsConfirmedAt) {
      return {
        statusLabel: '待你處理', tone: 'warn', headline: '輪到房東確認條件',
        detail: `請確認第 ${latest.versionNumber} 版條件，房客才能送出簽署。`,
        action: { label: '確認合約條件', url: draftUrl }, needsAttention: true
      };
    }
    if (roleSet.has('tenant') && latest.landlordTermsConfirmedAt) {
      return {
        statusLabel: '待你處理', tone: 'active', headline: '房東已確認，等待房客送簽',
        detail: `第 ${latest.versionNumber} 版草稿已準備完成。`,
        action: { label: '查看草稿並送簽', url: draftUrl }, needsAttention: true
      };
    }
    return {
      statusLabel: '等待中', tone: 'neutral', headline: '草稿完成，等待房東確認',
      detail: `目前是第 ${latest.versionNumber} 版，你暫時不需要操作。`,
      action: { label: '查看合約草稿', url: draftUrl }, needsAttention: false
    };
  }
  if (latest.status === 'issued') {
    if (!tenantSigned && roleSet.has('tenant') && activeRequest(tenantRequest)) {
      return {
        statusLabel: '待你處理', tone: 'active', headline: '現在輪到房客簽署',
        detail: '請完成 OTP、閱讀、身分資料、錄影與簽名。',
        action: { label: '繼續房客簽署', url: `/v2/sign/${encodeURIComponent(tenantRequest.publicId)}` }, needsAttention: true
      };
    }
    if (!tenantSigned) {
      return {
        statusLabel: '簽署中', tone: 'neutral', headline: '等待房客完成簽署',
        detail: '房客完成後才會輪到房東。', action: { label: '查看合約草稿', url: draftUrl }, needsAttention: false
      };
    }
    if (!landlordSigned && roleSet.has('landlord') && activeRequest(landlordRequest)) {
      return {
        statusLabel: '待你處理', tone: 'active', headline: '房客已簽，現在輪到房東',
        detail: '請完成最終確認與房東簽署。',
        action: { label: '繼續房東簽署', url: `/v2/sign/${encodeURIComponent(landlordRequest.publicId)}` }, needsAttention: true
      };
    }
    return {
      statusLabel: '簽署中', tone: 'neutral', headline: '房客已簽，等待房東簽署',
      detail: '房東完成簽署後，合約才會正式成立。', action: { label: '查看合約草稿', url: draftUrl }, needsAttention: false
    };
  }
  return {
    statusLabel: '處理中', tone: 'neutral', headline: '合約正在處理中',
    detail: '可開啟合約查看最新狀態。', action: { label: '查看合約', url: draftUrl }, needsAttention: false
  };
}

async function listContracts(db, lineUserId) {
  return db.all(`
    SELECT DISTINCT c.id, c.public_id AS contractPublicId, c.status, c.executed_at AS executedAt,
           c.updated_at AS updatedAt, p.address_text AS addressText, p.building_name AS buildingName,
           ru.unit_label AS unitLabel, l.title AS listingTitle
    FROM line_identities li
    JOIN contract_parties cp ON cp.user_id=li.user_id AND cp.status<>'removed'
    JOIN contracts c ON c.id=cp.contract_id
    JOIN rental_units ru ON ru.id=c.rental_unit_id
    JOIN properties p ON p.id=ru.property_id
    LEFT JOIN inquiries i ON i.id=c.source_inquiry_id
    LEFT JOIN listings l ON l.id=i.listing_id
    WHERE li.line_user_id=?
    ORDER BY CASE c.status WHEN 'signing' THEN 0 WHEN 'awaiting_confirmation' THEN 1
             WHEN 'drafting' THEN 2 WHEN 'executed' THEN 3 ELSE 4 END,
             c.updated_at DESC, c.id DESC
  `, [lineUserId]);
}

async function enrichContract(db, viewer, contract) {
  const roles = (await db.all(`
    SELECT DISTINCT cp.party_role AS partyRole
    FROM contract_parties cp WHERE cp.contract_id=? AND cp.user_id=? AND cp.status<>'removed'
  `, [contract.id, viewer.user_id])).map((row) => row.partyRole);
  const latest = await db.get(`
    SELECT id, public_id AS publicId, version_number AS versionNumber, status,
           condition_snapshot_json AS conditionSnapshotJson, created_at AS createdAt,
           landlord_terms_confirmed_at AS landlordTermsConfirmedAt
    FROM contract_versions WHERE contract_id=? ORDER BY version_number DESC,id DESC LIMIT 1
  `, [contract.id]);
  const requests = latest ? await db.all(`
    SELECT sr.public_id AS publicId, sr.status, cp.party_role AS partyRole, cp.user_id AS userId
    FROM signature_requests sr JOIN contract_parties cp ON cp.id=sr.contract_party_id
    WHERE sr.contract_version_id=? ORDER BY COALESCE(cp.signing_order,99),cp.id
  `, [latest.id]) : [];
  const signedRoles = new Set(latest ? (await db.all(`
    SELECT DISTINCT cp.party_role AS partyRole
    FROM signature_records sr JOIN contract_parties cp ON cp.id=sr.contract_party_id
    WHERE sr.contract_version_id=?
  `, [latest.id])).map((row) => row.partyRole) : []);
  const state = deriveState({ contract, latest, roles, requests, signedRoles });
  const conditions = parseConditions(latest && latest.conditionSnapshotJson);
  return {
    ...contract,
    title: subjectLabel(contract),
    roles,
    latestVersionNumber: latest ? Number(latest.versionNumber) : null,
    leaseStartDate: conditions.leaseStartDate || conditions.leaseStart || conditions.moveInDate || null,
    leaseEndDate: conditions.leaseEndDate || conditions.leaseEnd || null,
    stage: stageFor(contract, latest, signedRoles),
    ...state
  };
}

async function getContractCenter({ db, lineUserId }) {
  const viewer = await repository.findViewer(db, lineUserId);
  if (!viewer) {
    const error = new Error('forbidden');
    error.statusCode = 403;
    throw error;
  }
  const contracts = [];
  for (const contract of await listContracts(db, lineUserId)) {
    contracts.push(await enrichContract(db, viewer, contract));
  }
  const attention = contracts.find((contract) => contract.needsAttention)
    || contracts.find((contract) => ACTIVE_CONTRACT_STATUSES.has(contract.status))
    || contracts[0]
    || null;
  return {
    attention,
    currentContracts: contracts.filter((contract) => ACTIVE_CONTRACT_STATUSES.has(contract.status)),
    history: contracts.filter((contract) => !ACTIVE_CONTRACT_STATUSES.has(contract.status))
  };
}

module.exports = { getContractCenter };
