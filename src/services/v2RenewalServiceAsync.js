// 續約(renewal)服務。流程分三段,對應 renewal_requests 的三個欄位與
// renewal_proposals/renewal_decisions:
//
//   1. 提出續約 initiateRenewal——房客或房東任一方在租約有效期間主動提出
//      (LINE Rich Menu「續約租約」)。同一份租約同時只允許一筆進行中的續約
//      申請,靠 findOpenRenewalRequestForLease 天然去重。
//   2. 房東選擇續約處理方式——
//        LINE 卡片將舊 Q1/Q2 合併為沿用原條件、調整條件、不續約三選一。
//        底層仍保留 answerLandlordWillingness / answerCurrentTermsReusable，讓已發出的
//        舊 LINE 卡片仍可使用，也維持原本的冪等與權限邊界。
//      沿用時系統直接複製目前生效版本的條件、把租期平移一個週期,自動產生
//      提案;不沿用則等房東呼叫 submitRenewalProposal 自己填新條件。
//   3. 房客決定 submitTenantRenewalDecision——接受 / 拒絕 / 要求修改。
//      接受只代表雙方同意續約條件,申請停在 accepted,不會自行建立或執行合約。
//      後續合約模組可透過 getAcceptedRenewalContractHandoff 取得完整條件快照,
//      再走既有的合約確認與電子簽署流程。要求修改時由房客先提出具體條件,
//      房東再選擇接受、另提條件或不續約。
//
// 跟既有的 ecsNeoLandlordDecisionServiceAsync 同樣的約定:
//   - fail() 帶 code/statusCode,不是裸 Error。
//   - 每個會被重送的操作都用「目前狀態」判斷冪等,回 { applied:false, replayed:true, ... }
//     而不是丟錯誤。
//   - 通知一律走 outbox(enqueueNotification),而且只在同一個交易內呼叫,
//     不在交易外或交易中呼叫任何外部 API。
//   - 這支完全不碰 v2ContractSigningServiceAsync / ecsNeoRentalUnitClaimServiceAsync。
//     續約服務只準備交接資料,不越過合約模組直接建立已執行合約或新租約。

const repo = require('../repositories/v2RenewalRepositoryAsync');
const { enqueueNotification } = require('./ecsNeoOutboxAsync');

function fail(message, code, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

async function recipientsFor(tx, leaseId, role, { excludeUserId } = {}) {
  const partyUsers = await repo.listLeasePartyUsers(tx, leaseId);
  return partyUsers
    .filter((row) => row.party_role === role && row.user_id !== excludeUserId)
    .map((row) => ({ role, userId: row.user_id }));
}

// 租期原樣平移一個週期:新開始日 = 舊到期日 + 1 天,新到期日照舊租期長度算。
// 只有「沿用現有條件」這條路會用到;房東自己填新條件時不套用這個規則。
function shiftLeasePeriod(oldStartDate, oldEndDate) {
  const oldStart = new Date(`${oldStartDate}T00:00:00Z`);
  const oldEnd = new Date(`${oldEndDate}T00:00:00Z`);
  const durationDays = Math.round((oldEnd - oldStart) / 86400000);
  const start = new Date(oldEnd);
  start.setUTCDate(start.getUTCDate() + 1);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + durationDays);
  const iso = (date) => date.toISOString().slice(0, 10);
  return { startDate: iso(start), endDate: iso(end) };
}

function proposalConditionSnapshot(sourceSnapshot, {
  proposedStartDate, proposedEndDate, rentAmount, depositAmount, termsJson, renewalNegotiable
}) {
  return {
    ...(sourceSnapshot || {}),
    ...(termsJson || {}),
    rentAmount: Number(rentAmount),
    depositAmount: depositAmount === undefined || depositAmount === null ? null : Number(depositAmount),
    leaseStartDate: proposedStartDate,
    leaseEndDate: proposedEndDate,
    renewalNegotiable: Boolean(renewalNegotiable)
  };
}

/** LINE Rich Menu「續約租約」入口用:找這個人目前 active 的租約。沒有就回 null。 */
async function findMyActiveLeaseForRenewal({ db, lineUserId }) {
  const lease = await repo.findActiveLeaseForViewer(db, lineUserId);
  if (!lease) return null;
  return {
    leasePublicId: lease.lease_public_id,
    role: lease.party_role,
    startDate: lease.start_date,
    endDate: lease.end_date
  };
}

/**
 * LINE 入口用。相同租約、相同 LINE 身分可以同時擁有房東與房客角色；
 * 回傳時把角色收在同一筆租約裡，讓畫面要求使用者明確選擇本次操作身分。
 */
async function listMyActiveLeasesForRenewal({ db, lineUserId }) {
  const rows = await repo.findActiveLeasesForViewer(db, lineUserId);
  const grouped = new Map();
  for (const row of rows) {
    let lease = grouped.get(row.lease_public_id);
    if (!lease) {
      let snapshot = {};
      try {
        snapshot = JSON.parse(row.condition_snapshot_json || '{}');
      } catch {
        snapshot = {};
      }
      lease = {
        leasePublicId: row.lease_public_id,
        rentalUnitId: row.rental_unit_id,
        listingTitle: row.listing_title || null,
        propertyLabel: [row.building_name, row.address_text, row.unit_label].filter(Boolean).join(' '),
        tenantName: row.tenant_name || '房客',
        startDate: row.start_date,
        endDate: row.end_date,
        rentAmount: snapshot.rentAmount ?? null,
        depositAmount: snapshot.depositAmount ?? null,
        roles: []
      };
      grouped.set(row.lease_public_id, lease);
    }
    if (!lease.roles.includes(row.party_role)) lease.roles.push(row.party_role);
  }
  return [...grouped.values()];
}

async function getLandlordRenewalPreference({ db, lineUserId }) {
  return repo.getLandlordRenewalPreference(db, lineUserId);
}

async function setLandlordRenewalPreference({ db, lineUserId, unchangedTermsNegotiable }) {
  return repo.setLandlordRenewalPreference(db, { lineUserId, unchangedTermsNegotiable });
}

async function initiateRenewal({ db, lineUserId, leasePublicId, actingRole, reason }) {
  const party = await repo.requireLeaseParty(db, { lineUserId, leasePublicId, partyRole: actingRole });
  if (!['tenant', 'landlord'].includes(party.party_role)) {
    throw fail('只有房東或房客可以提出續約', 'authorization_denied', 403);
  }
  if (party.lease_status !== 'active') {
    throw fail('這份租約目前不是租賃中狀態，不能提出續約', 'invalid_lease_status');
  }

  return db.transaction(async (tx) => {
    const open = await repo.findOpenRenewalRequestForLease(tx, party.lease_id);
    if (open) {
      return {
        applied: false,
        replayed: true,
        renewalRequestPublicId: open.public_id,
        initiatedBy: open.initiated_by,
        landlordWilling: open.landlord_willing === null ? null : Boolean(open.landlord_willing),
        currentTermsReusable: open.current_terms_reusable === null ? null : Boolean(open.current_terms_reusable)
      };
    }
    const completed = await repo.findCompletedRenewalRequestForLease(tx, party.lease_id);
    if (completed) {
      throw fail('這份租約已經完成續約，不能再次提出續約申請', 'renewal_already_completed');
    }
    const declinedByLandlord = await repo.findLandlordDeclinedRenewalForLease(tx, party.lease_id);
    if (declinedByLandlord) {
      throw fail('房東已確認這份現行租約不續約，不能再次提出申請', 'renewal_declined_by_landlord');
    }
    const created = await repo.createRenewalRequest(tx, {
      leaseId: party.lease_id,
      contractId: party.contract_id,
      requestedByContractPartyId: party.contract_party_id,
      actorUserId: party.user_id,
      initiatedBy: party.party_role,
      reason,
      landlordWilling: null
    });
    return {
      applied: true,
      replayed: false,
      renewalRequestPublicId: created.renewalRequestPublicId,
      initiatedBy: party.party_role,
      landlordWilling: null,
      currentTermsReusable: null
    };
  });
}

/** 記錄房東是否續約。不續約就結束這筆申請並通知房客。 */
async function answerLandlordWillingness({
  db, lineUserId, renewalRequestPublicId, willing, notifyTenant = true
}) {
  const request = await repo.getRenewalRequestByPublicId(db, renewalRequestPublicId);
  const party = await repo.requireLeaseParty(db, {
    lineUserId, leasePublicId: request.lease_public_id, partyRole: 'landlord'
  });

  // 這一題本身可能就是讓申請關閉的那一步(答「不願意」會直接結束申請),所以不能先
  // 檢查「申請是不是還 pending」再決定要不要處理——重送同一個答案時申請早就已經
  // 被自己關掉了。冪等邊界只看 landlord_willing 是不是還是 NULL:還是 NULL 才是
  // 「第一次回答」,交易內的 atomic UPDATE 本身就保證了併發安全。
  return db.transaction(async (tx) => {
    const applied = await repo.setLandlordWilling(tx, { renewalRequestId: request.id, willing: Boolean(willing) });
    if (!applied) {
      const fresh = await repo.getRenewalAnswers(tx, request.id);
      return { applied: false, replayed: true, landlordWilling: Boolean(fresh.landlord_willing) };
    }
    if (!willing) {
      await repo.transitionActionRequest(tx, {
        actionRequestId: request.contract_action_request_id,
        fromStatuses: ['pending'],
        toStatus: 'rejected',
        actorUserId: party.user_id,
        note: '房東表示不願意續約'
      });
      await enqueueNotification(tx, {
        eventType: 'renewal_declined_by_landlord',
        entityType: 'renewal_request',
        entityId: renewalRequestPublicId,
        payload: { renewalRequestPublicId },
        recipients: await recipientsFor(tx, request.lease_id, 'tenant', { excludeUserId: party.user_id }),
        idempotencyKey: `renewal-declined:${renewalRequestPublicId}`
      });
      return { applied: true, replayed: false, landlordWilling: false, closed: true };
    }
    if (notifyTenant) {
      await enqueueNotification(tx, {
        eventType: 'renewal_landlord_willing',
        entityType: 'renewal_request',
        entityId: renewalRequestPublicId,
        payload: { renewalRequestPublicId },
        recipients: await recipientsFor(tx, request.lease_id, 'tenant', { excludeUserId: party.user_id }),
        idempotencyKey: `renewal-willing:${renewalRequestPublicId}`
      });
    }
    return { applied: true, replayed: false, landlordWilling: true, closed: false };
  });
}

/** Q2:沿用現有條件(自動產生提案)或另外提新條件(等房東呼叫 submitRenewalProposal)。 */
async function answerCurrentTermsReusable({ db, lineUserId, renewalRequestPublicId, reusable }) {
  const request = await repo.getRenewalRequestByPublicId(db, renewalRequestPublicId);
  const party = await repo.requireLeaseParty(db, {
    lineUserId, leasePublicId: request.lease_public_id, partyRole: 'landlord'
  });
  // Q2 本身不會關閉申請(沿用/不沿用都還要等房客決定),所以這裡先檢查申請是不是
  // 還開著沒問題——不會像 Q1 那樣把自己的重送誤判成「申請已結束」。這裡先判斷
  // status 而不是先判斷 landlord_willing,是為了在「Q1 已經回答不願意續約」時
  // 回報 stale_version(申請已經結束),而不是 invalid_state(還沒到這一步)。
  if (request.action_status !== 'pending') throw fail('這筆續約申請已經結束，不能再回答', 'stale_version');
  const legacyLandlordStart = request.initiated_by === 'landlord' && request.landlord_willing === null;
  if (request.landlord_willing !== 1 && !legacyLandlordStart) {
    throw fail('房東還沒表示願意續約，不能跳到這一步', 'invalid_state');
  }

  return db.transaction(async (tx) => {
    // 舊版房東卡片會直接送出 Q2。改版後「發起」不再代表願意續約，
    // 但已經發出的舊卡仍要可以使用；房東選擇沿用或調整時再補記願意。
    if (legacyLandlordStart) {
      await repo.setLandlordWilling(tx, { renewalRequestId: request.id, willing: true });
    }
    const applied = await repo.setCurrentTermsReusable(tx, { renewalRequestId: request.id, reusable: Boolean(reusable) });
    if (!applied) {
      const fresh = await repo.getRenewalAnswers(tx, request.id);
      return { applied: false, replayed: true, currentTermsReusable: Boolean(fresh.current_terms_reusable) };
    }
    if (!reusable) {
      return { applied: true, replayed: false, currentTermsReusable: false, proposal: null, waitingFor: 'landlord_proposal' };
    }

    const preference = await repo.getLandlordRenewalPreferenceByUserId(tx, party.user_id);
    const effectiveNegotiable = preference.unchangedTermsNegotiable;
    const snapshot = await repo.getExecutedConditionSnapshot(tx, request.contract_id);
    if (!snapshot || snapshot.rentAmount === undefined || snapshot.rentAmount === null) {
      throw fail('找不到目前合約的租金條件，無法自動沿用，請改用自訂條件提出續約條件', 'renewal_source_incomplete');
    }
    const { startDate, endDate } = shiftLeasePeriod(request.lease_start_date, request.lease_end_date);
    const proposal = await repo.insertRenewalProposal(tx, {
      renewalRequestId: request.id,
      proposedStartDate: startDate,
      proposedEndDate: endDate,
      rentAmount: snapshot.rentAmount,
      depositAmount: snapshot.depositAmount ?? null,
      termsJson: proposalConditionSnapshot(snapshot, {
        proposedStartDate: startDate,
        proposedEndDate: endDate,
        rentAmount: snapshot.rentAmount,
        depositAmount: snapshot.depositAmount,
        termsJson: { renewalProposedByRole: 'landlord' },
        renewalNegotiable: effectiveNegotiable
      }),
      proposedByUserId: party.user_id
    });
    await enqueueNotification(tx, {
      eventType: 'renewal_proposal_ready',
      entityType: 'renewal_proposal',
      entityId: proposal.public_id,
      payload: {
        renewalRequestPublicId,
        proposalPublicId: proposal.public_id,
        reused: true,
        negotiable: effectiveNegotiable
      },
      recipients: await recipientsFor(tx, request.lease_id, 'tenant', { excludeUserId: party.user_id }),
      idempotencyKey: `renewal-proposal:${proposal.public_id}`
    });
    return {
      applied: true,
      replayed: false,
      currentTermsReusable: true,
      negotiable: effectiveNegotiable,
      waitingFor: 'tenant_decision',
      proposal: {
        publicId: proposal.public_id,
        versionNumber: proposal.version_number,
        startDate: proposal.proposed_start_date,
        endDate: proposal.proposed_end_date,
        rentAmount: proposal.rent_amount,
        depositAmount: proposal.deposit_amount
      }
    };
  });
}

/** 房東自己填新條件——Q2 選「不沿用」之後,或房客要求修改之後,都走這支。 */
async function submitRenewalProposal({
  db, lineUserId, renewalRequestPublicId, proposedStartDate, proposedEndDate, rentAmount, depositAmount, termsJson
}) {
  const request = await repo.getRenewalRequestByPublicId(db, renewalRequestPublicId);
  const party = await repo.requireLeaseParty(db, {
    lineUserId, leasePublicId: request.lease_public_id, partyRole: 'landlord'
  });
  if (request.action_status !== 'pending') throw fail('這筆續約申請已經結束，不能再提出條件', 'stale_version');
  if (request.landlord_willing !== 1) throw fail('房東還沒表示願意續約，不能提出條件', 'invalid_state');
  if (!proposedStartDate || !proposedEndDate || !Number.isFinite(Number(rentAmount))) {
    throw fail('租期與租金是必填', 'invalid_input', 400);
  }
  if (String(proposedEndDate) < String(proposedStartDate)) {
    throw fail('租期結束日不能早於開始日', 'invalid_input', 400);
  }

  return db.transaction(async (tx) => {
    const sourceSnapshot = await repo.getExecutedConditionSnapshot(tx, request.contract_id);
    if (!sourceSnapshot) {
      throw fail('找不到目前合約條件，無法準備續約提案', 'renewal_source_incomplete');
    }
    const proposal = await repo.insertRenewalProposal(tx, {
      renewalRequestId: request.id,
      proposedStartDate,
      proposedEndDate,
      rentAmount: Number(rentAmount),
      depositAmount: depositAmount === undefined || depositAmount === null ? null : Number(depositAmount),
      termsJson: proposalConditionSnapshot(sourceSnapshot, {
        proposedStartDate,
        proposedEndDate,
        rentAmount,
        depositAmount,
        termsJson: { ...(termsJson || {}), renewalProposedByRole: 'landlord' },
        renewalNegotiable: true
      }),
      proposedByUserId: party.user_id
    });
    if (!proposal.replayed) {
      await enqueueNotification(tx, {
        eventType: 'renewal_proposal_ready',
        entityType: 'renewal_proposal',
        entityId: proposal.public_id,
        payload: { renewalRequestPublicId, proposalPublicId: proposal.public_id, reused: false },
        recipients: await recipientsFor(tx, request.lease_id, 'tenant', { excludeUserId: party.user_id }),
        idempotencyKey: `renewal-proposal:${proposal.public_id}`
      });
    }
    return {
      applied: !proposal.replayed,
      replayed: Boolean(proposal.replayed),
      proposal: {
        publicId: proposal.public_id,
        versionNumber: proposal.version_number,
        startDate: proposal.proposed_start_date,
        endDate: proposal.proposed_end_date,
        rentAmount: proposal.rent_amount,
        depositAmount: proposal.deposit_amount
      }
    };
  });
}

/** 房客主動提出沿用原條件，系統只平移租期，其餘合約條件完整保留。 */
async function submitTenantOriginalTermsProposal({ db, lineUserId, renewalRequestPublicId }) {
  const request = await repo.getRenewalRequestByPublicId(db, renewalRequestPublicId);
  await repo.requireLeaseParty(db, {
    lineUserId, leasePublicId: request.lease_public_id, partyRole: 'tenant'
  });
  const snapshot = await repo.getExecutedConditionSnapshot(db, request.contract_id);
  if (!snapshot || snapshot.rentAmount === undefined || snapshot.rentAmount === null) {
    throw fail('找不到目前合約的租金條件，無法自動沿用', 'renewal_source_incomplete');
  }
  const { startDate, endDate } = shiftLeasePeriod(request.lease_start_date, request.lease_end_date);
  return submitTenantChangeProposal({
    db,
    lineUserId,
    renewalRequestPublicId,
    proposedStartDate: startDate,
    proposedEndDate: endDate,
    rentAmount: snapshot.rentAmount,
    depositAmount: snapshot.depositAmount ?? null,
    termsJson: { renewalReusedOriginalTerms: true }
  });
}

/** 房客主動提出第一版條件，或在可協商提案上形成下一版反提案。 */
async function submitTenantChangeProposal({
  db, lineUserId, renewalRequestPublicId, proposedStartDate, proposedEndDate, rentAmount, depositAmount, termsJson
}) {
  const request = await repo.getRenewalRequestByPublicId(db, renewalRequestPublicId);
  const party = await repo.requireLeaseParty(db, {
    lineUserId, leasePublicId: request.lease_public_id, partyRole: 'tenant'
  });
  if (request.action_status !== 'pending') throw fail('這筆續約申請已經結束，不能再提出條件', 'stale_version');
  if (!proposedStartDate || !proposedEndDate || !Number.isFinite(Number(rentAmount))) {
    throw fail('租期與租金是必填', 'invalid_input', 400);
  }
  if (String(proposedEndDate) < String(proposedStartDate)) {
    throw fail('租期結束日不能早於開始日', 'invalid_input', 400);
  }

  return db.transaction(async (tx) => {
    const previousProposal = await repo.latestProposalForRequest(tx, request.id);
    if (previousProposal) {
      const previousDecision = await repo.findDecisionForProposal(tx, previousProposal.id);
      if (!previousDecision || previousDecision.decision !== 'changes_requested'
          || previousDecision.decided_by_user_id !== party.user_id) {
        throw fail('目前不是由房客提出修改條件的階段', 'invalid_state');
      }
    } else if (request.initiated_by !== 'tenant') {
      throw fail('只有房客主動發起續約時能先提出條件', 'invalid_state');
    }
    const sourceSnapshot = await repo.getExecutedConditionSnapshot(tx, request.contract_id);
    if (!sourceSnapshot) throw fail('找不到目前合約條件，無法準備續約提案', 'renewal_source_incomplete');
    const proposal = await repo.insertRenewalProposal(tx, {
      renewalRequestId: request.id,
      proposedStartDate,
      proposedEndDate,
      rentAmount: Number(rentAmount),
      depositAmount: depositAmount === undefined || depositAmount === null ? null : Number(depositAmount),
      termsJson: proposalConditionSnapshot(sourceSnapshot, {
        proposedStartDate,
        proposedEndDate,
        rentAmount,
        depositAmount,
        termsJson: { ...(termsJson || {}), renewalProposedByRole: 'tenant' },
        renewalNegotiable: true
      }),
      proposedByUserId: party.user_id
    });
    if (!proposal.replayed) {
      await enqueueNotification(tx, {
        eventType: 'renewal_tenant_counterproposal_ready',
        entityType: 'renewal_proposal',
        entityId: proposal.public_id,
        payload: {
          renewalRequestPublicId,
          proposalPublicId: proposal.public_id,
          reused: Boolean(termsJson && termsJson.renewalReusedOriginalTerms)
        },
        recipients: await recipientsFor(tx, request.lease_id, 'landlord', { excludeUserId: party.user_id }),
        idempotencyKey: `renewal-tenant-counterproposal:${proposal.public_id}`
      });
    }
    return {
      applied: !proposal.replayed,
      replayed: Boolean(proposal.replayed),
      reused: Boolean(termsJson && termsJson.renewalReusedOriginalTerms),
      proposal: {
        publicId: proposal.public_id,
        versionNumber: proposal.version_number,
        startDate: proposal.proposed_start_date,
        endDate: proposal.proposed_end_date,
        rentAmount: proposal.rent_amount,
        depositAmount: proposal.deposit_amount
      }
    };
  });
}

/** 房東回覆房客的具體反提案。另提條件由 LINE handler 回到房東輸入流程。 */
async function decideTenantChangeProposal({ db, lineUserId, renewalRequestPublicId, action }) {
  if (!['accept', 'reject'].includes(action)) throw fail('未知的房東決定', 'invalid_input', 400);
  const request = await repo.getRenewalRequestByPublicId(db, renewalRequestPublicId);
  const landlord = await repo.requireLeaseParty(db, {
    lineUserId, leasePublicId: request.lease_public_id, partyRole: 'landlord'
  });

  return db.transaction(async (tx) => {
    const proposal = await repo.latestProposalForRequest(tx, request.id);
    if (!proposal) throw fail('找不到房客提出的修改條件', 'invalid_state');
    let proposalTerms = {};
    try { proposalTerms = JSON.parse(proposal.terms_json || '{}'); } catch { proposalTerms = {}; }
    const partyUsers = await repo.listLeasePartyUsers(tx, request.lease_id);
    const proposedByTenant = proposalTerms.renewalProposedByRole === 'tenant'
      || (!proposalTerms.renewalProposedByRole && partyUsers.some((row) => (
        row.party_role === 'tenant' && row.user_id === proposal.proposed_by_user_id
      )));
    if (!proposedByTenant) throw fail('最新一版不是房客提出的條件', 'invalid_state');
    const existingDecision = await repo.findDecisionForProposal(tx, proposal.id);
    if (existingDecision) {
      return { applied: false, replayed: true, decision: existingDecision.decision };
    }
    if (request.action_status !== 'pending') throw fail('這筆續約申請已經結束', 'stale_version');

    const decision = action === 'accept' ? 'accepted' : 'rejected';
    await repo.insertRenewalDecision(tx, {
      renewalRequestId: request.id,
      renewalProposalId: proposal.id,
      decidedByUserId: landlord.user_id,
      decision,
      reason: action === 'accept' ? '房東接受房客提出的續約條件' : '房東不接受房客提出的續約條件並決定不續約'
    });
    await repo.transitionActionRequest(tx, {
      actionRequestId: request.contract_action_request_id,
      fromStatuses: ['pending'],
      toStatus: decision,
      actorUserId: landlord.user_id,
      note: action === 'accept' ? '房東接受房客續約條件' : '房東確認不續約'
    });
    await enqueueNotification(tx, {
      eventType: action === 'accept' ? 'renewal_counterproposal_accepted' : 'renewal_declined_by_landlord',
      entityType: 'renewal_request',
      entityId: renewalRequestPublicId,
      payload: { renewalRequestPublicId, proposalPublicId: proposal.public_id },
      recipients: await recipientsFor(tx, request.lease_id, 'tenant', { excludeUserId: landlord.user_id }),
      idempotencyKey: `renewal-landlord-counter-${action}:${proposal.public_id}`
    });
    return {
      applied: true,
      replayed: false,
      decision,
      closed: action === 'reject',
      waitingFor: action === 'accept' ? 'contract_draft' : null,
      contractHandoffReady: action === 'accept'
    };
  });
}

const TENANT_DECISION_BY_ACTION = Object.freeze({
  accept: 'accepted',
  reject: 'rejected',
  request_changes: 'changes_requested'
});

/**
 * 房客對最新一版續約提案的決定。
 * accept 只把條件標成已接受,等待合約模組接手建立草稿與完成簽署;
 * reject 結束這筆續約申請;request_changes 先等待房客輸入具體修改條件。
 */
async function submitTenantRenewalDecision({ db, lineUserId, renewalRequestPublicId, action, reason }) {
  const decision = TENANT_DECISION_BY_ACTION[action];
  if (!decision) throw fail(`未知的房客決定 ${action}`, 'invalid_input', 400);

  const request = await repo.getRenewalRequestByPublicId(db, renewalRequestPublicId);
  const party = await repo.requireLeaseParty(db, {
    lineUserId, leasePublicId: request.lease_public_id, partyRole: 'tenant'
  });

  // accept/reject 都會讓申請結束,所以跟 Q1 一樣:先看「這一版提案是不是已經有
  // 決定了」,有的話不管申請現在是什麼狀態都當成回放——不能讓 accept 自己造成
  // 的關閉,反過來讓 accept 的重送被當成「申請已結束」的錯誤。只有在**還沒有
  // 決定**的情況下,才需要用「申請是不是還 pending」擋掉真正過期的操作。
  return db.transaction(async (tx) => {
    const proposal = await repo.latestProposalForRequest(tx, request.id);
    if (!proposal) throw fail('房東還沒提出續約條件，還不能決定', 'invalid_state');

    const existingDecision = await repo.findDecisionForProposal(tx, proposal.id);
    if (existingDecision) {
      return { applied: false, replayed: true, decision: existingDecision.decision };
    }
    if (request.action_status !== 'pending') throw fail('這筆續約申請已經結束，不能再做決定', 'stale_version');

    let proposalTerms = {};
    try {
      proposalTerms = JSON.parse(proposal.terms_json || '{}');
    } catch {
      proposalTerms = {};
    }
    if (decision === 'changes_requested' && proposalTerms.renewalNegotiable === false) {
      throw fail('這份續約提案是固定條件，不能提出修改', 'changes_not_allowed');
    }

    await repo.insertRenewalDecision(tx, {
      renewalRequestId: request.id,
      renewalProposalId: proposal.id,
      decidedByUserId: party.user_id,
      decision,
      reason
    });

    if (decision === 'rejected') {
      await repo.transitionActionRequest(tx, {
        actionRequestId: request.contract_action_request_id,
        fromStatuses: ['pending'],
        toStatus: 'rejected',
        actorUserId: party.user_id,
        note: '房客拒絕續約條件'
      });
      await enqueueNotification(tx, {
        eventType: 'renewal_rejected_by_tenant',
        entityType: 'renewal_request',
        entityId: renewalRequestPublicId,
        payload: { renewalRequestPublicId },
        recipients: await recipientsFor(tx, request.lease_id, 'landlord', { excludeUserId: party.user_id }),
        idempotencyKey: `renewal-tenant-rejected:${renewalRequestPublicId}`
      });
      return { applied: true, replayed: false, decision, closed: true };
    }

    if (decision === 'changes_requested') {
      return { applied: true, replayed: false, decision, closed: false, waitingFor: 'tenant_change_proposal' };
    }

    await repo.transitionActionRequest(tx, {
      actionRequestId: request.contract_action_request_id,
      fromStatuses: ['pending'],
      toStatus: 'accepted',
      actorUserId: party.user_id,
      note: '房客接受續約條件'
    });
    await enqueueNotification(tx, {
      eventType: 'renewal_terms_accepted',
      entityType: 'renewal_request',
      entityId: renewalRequestPublicId,
      payload: { renewalRequestPublicId, proposalPublicId: proposal.public_id },
      recipients: await recipientsFor(tx, request.lease_id, 'landlord', { excludeUserId: party.user_id }),
      idempotencyKey: `renewal-terms-accepted:${renewalRequestPublicId}`
    });
    return {
      applied: true,
      replayed: false,
      decision,
      closed: false,
      waitingFor: 'contract_draft',
      contractHandoffReady: true
    };
  });
}

/**
 * 提供給未來合約串接使用的唯讀介面。只回傳已由另一方接受的最新版條件，
 * 不建立合約、不寫入租約，也不呼叫合約模組。
 */
async function getAcceptedRenewalContractHandoff({ db, renewalRequestPublicId }) {
  const request = await repo.getRenewalRequestByPublicId(db, renewalRequestPublicId);
  if (request.action_status !== 'accepted') {
    throw fail('續約條件尚未由雙方確認，不能建立合約交接資料', 'renewal_not_accepted');
  }
  const proposal = await repo.latestProposalForRequest(db, request.id);
  if (!proposal) throw fail('找不到已接受的續約提案', 'renewal_source_incomplete');
  const decision = await repo.findDecisionForProposal(db, proposal.id);
  if (!decision || decision.decision !== 'accepted') {
    throw fail('最新版續約提案尚未被接受', 'renewal_not_accepted');
  }

  let conditionSnapshot = {};
  try {
    conditionSnapshot = JSON.parse(proposal.terms_json || '{}');
  } catch {
    throw fail('續約條件資料無法解析', 'renewal_source_incomplete');
  }
  delete conditionSnapshot.renewalNegotiable;
  delete conditionSnapshot.renewalProposedByRole;
  delete conditionSnapshot.renewalReusedOriginalTerms;
  conditionSnapshot.rentAmount = proposal.rent_amount;
  conditionSnapshot.depositAmount = proposal.deposit_amount;
  conditionSnapshot.leaseStartDate = proposal.proposed_start_date;
  conditionSnapshot.leaseEndDate = proposal.proposed_end_date;

  return {
    renewalRequestPublicId,
    actionRequestPublicId: request.action_request_public_id,
    sourceContractId: request.contract_id,
    sourceLeaseId: request.lease_id,
    sourceLeasePublicId: request.lease_public_id,
    rentalUnitId: request.rental_unit_id,
    proposalPublicId: proposal.public_id,
    proposalVersionNumber: proposal.version_number,
    acceptedByUserId: decision.decided_by_user_id,
    conditionSnapshot
  };
}

/** 續約狀態頁用的唯讀彙總。 */
async function getRenewalStatusForViewer({ db, lineUserId, renewalRequestPublicId }) {
  const request = await repo.getRenewalRequestByPublicId(db, renewalRequestPublicId);
  const parties = await repo.listLeasePartiesForViewer(db, {
    lineUserId, leasePublicId: request.lease_public_id
  });
  if (!parties.length) repo.forbidden('這份續約申請跟這個 LINE 身分對不起來');
  const proposal = await repo.latestProposalForRequest(db, request.id);
  const decision = proposal ? await repo.findDecisionForProposal(db, proposal.id) : null;
  const partyUsers = proposal ? await repo.listLeasePartyUsers(db, request.lease_id) : [];
  let proposalTerms = {};
  try { proposalTerms = proposal ? JSON.parse(proposal.terms_json || '{}') : {}; } catch { proposalTerms = {}; }
  const proposer = proposal
    ? partyUsers.find((party) => party.user_id === proposal.proposed_by_user_id)
    : null;
  return {
    renewalRequestPublicId,
    viewerRole: parties.length === 1 ? parties[0].party_role : null,
    viewerRoles: parties.map((party) => party.party_role),
    status: request.action_status,
    initiatedBy: request.initiated_by,
    landlordWilling: request.landlord_willing === null ? null : Boolean(request.landlord_willing),
    currentTermsReusable: request.current_terms_reusable === null ? null : Boolean(request.current_terms_reusable),
    proposal: proposal ? {
      publicId: proposal.public_id,
      versionNumber: proposal.version_number,
      startDate: proposal.proposed_start_date,
      endDate: proposal.proposed_end_date,
      rentAmount: proposal.rent_amount,
      depositAmount: proposal.deposit_amount,
      reused: Boolean(proposalTerms.renewalReusedOriginalTerms),
      proposedByRole: proposalTerms.renewalProposedByRole || (proposer ? proposer.party_role : null)
    } : null,
    decision: decision ? { decision: decision.decision, reason: decision.reason, decidedAt: decision.decided_at } : null
  };
}

module.exports = {
  shiftLeasePeriod,
  findMyActiveLeaseForRenewal,
  listMyActiveLeasesForRenewal,
  getLandlordRenewalPreference,
  setLandlordRenewalPreference,
  initiateRenewal,
  answerLandlordWillingness,
  answerCurrentTermsReusable,
  submitRenewalProposal,
  submitTenantOriginalTermsProposal,
  submitTenantChangeProposal,
  decideTenantChangeProposal,
  submitTenantRenewalDecision,
  getAcceptedRenewalContractHandoff,
  getRenewalStatusForViewer
};
