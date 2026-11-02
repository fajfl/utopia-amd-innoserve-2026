const repository = require('../repositories/v2ContractRepository');
const conditionRepository = require('../repositories/v2ContractConditionRepository');
const conditionService = require('./v2ContractConditionService');

function createDraftVersion(input) {
  const created = repository.createVersionFromIntention(input.db, input);
  const attachment = conditionService.autoAttachLatestRecord(input.db, {
    contractId: created.contractId,
    contractVersionId: created.versionId,
    actorUserId: input.actorUserId || null
  });
  return { ...created, conditionRecordAttached: attachment.attached };
}

function getDraftOverview({ db, lineUserId, contractPublicId }) {
  const versions = repository.listVersionsForViewer(db, { lineUserId, contractPublicId });
  const counts = conditionRepository.listAttachmentCounts(db, versions.map((version) => version.id));
  return {
    contractPublicId,
    overview: repository.getContractOverviewForViewer(db, { lineUserId, contractPublicId }),
    versions: versions.map((version) => ({
      ...version,
      conditionRecord: counts.get(version.id) || { attachmentCount: 0, imageCount: 0, videoCount: 0 }
    }))
  };
}

function diffConditions(before, after) {
  return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .sort()
    .filter((field) => JSON.stringify(before?.[field]) !== JSON.stringify(after?.[field]))
    .map((field) => ({ field, before: before?.[field], after: after?.[field] }));
}

function compareDraftVersions({ db, lineUserId, leftVersionPublicId, rightVersionPublicId }) {
  const left = repository.getVersionForViewer(db, { lineUserId, versionPublicId: leftVersionPublicId });
  const right = repository.getVersionForViewer(db, { lineUserId, versionPublicId: rightVersionPublicId });
  if (left.contract_id !== right.contract_id) throw new Error('versions belong to different contracts');
  const leftAttachments = conditionRepository.listAttachments(db, left.id).map((row) => row.sessionPublicId);
  const rightAttachments = conditionRepository.listAttachments(db, right.id).map((row) => row.sessionPublicId);
  return {
    left: { publicId: left.public_id, versionNumber: left.version_number },
    right: { publicId: right.public_id, versionNumber: right.version_number },
    changes: diffConditions(JSON.parse(left.condition_snapshot_json), JSON.parse(right.condition_snapshot_json)),
    attachmentChanges: {
      added: rightAttachments.filter((id) => !leftAttachments.includes(id)),
      removed: leftAttachments.filter((id) => !rightAttachments.includes(id))
    }
  };
}

module.exports = { createDraftVersion, getDraftOverview, compareDraftVersions, diffConditions };
