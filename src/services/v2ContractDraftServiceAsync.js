// 合約草稿 service 的 driver 版本。本身沒有查詢,整支都在編排 repository。

const repository = require('../repositories/v2ContractRepositoryAsync');
const conditionRepository = require('../repositories/v2ContractConditionRepositoryAsync');
const conditionService = require('./v2ContractConditionServiceAsync');
const { diffConditions } = require('./v2ContractDraftService');
const { idEquals } = require('../database/idEquals');

async function createDraftVersion(input) {
  const created = await repository.createVersionFromIntention(input.db, input);
  const attachment = await conditionService.autoAttachLatestRecord(input.db, {
    contractId: created.contractId,
    contractVersionId: created.versionId,
    actorUserId: input.actorUserId || null
  });
  return { ...created, conditionRecordAttached: attachment.attached };
}

async function getDraftOverview({ db, lineUserId, contractPublicId }) {
  const versions = await repository.listVersionsForViewer(db, { lineUserId, contractPublicId });
  const counts = await conditionRepository.listAttachmentCounts(db, versions.map((version) => version.id));
  return {
    contractPublicId,
    overview: await repository.getContractOverviewForViewer(db, { lineUserId, contractPublicId }),
    versions: versions.map((version) => ({
      ...version,
      conditionRecord: counts.get(version.id) || { attachmentCount: 0, imageCount: 0, videoCount: 0 }
    }))
  };
}

async function compareDraftVersions({ db, lineUserId, leftVersionPublicId, rightVersionPublicId }) {
  const left = await repository.getVersionForViewer(db, { lineUserId, versionPublicId: leftVersionPublicId });
  const right = await repository.getVersionForViewer(db, { lineUserId, versionPublicId: rightVersionPublicId });
  if (!idEquals(left.contract_id, right.contract_id)) throw new Error('versions belong to different contracts');
  const leftAttachments = (await conditionRepository.listAttachments(db, left.id)).map((row) => row.sessionPublicId);
  const rightAttachments = (await conditionRepository.listAttachments(db, right.id)).map((row) => row.sessionPublicId);
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
