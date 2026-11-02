ALTER TABLE contracts ADD COLUMN signed_version_id BIGINT NULL;
ALTER TABLE contracts ADD COLUMN signed_document_hash CHAR(64) NULL;
UPDATE contracts c JOIN (
SELECT cv.contract_id, cv.id AS version_id, cv.public_id AS version_public_id, cv.version_number, cv.document_hash, f.id AS file_id, f.storage_key, f.storage_provider, f.sha256_hash, f.size_bytes, f.mime_type
FROM contract_versions cv JOIN files f ON f.id=cv.document_file_id
JOIN signature_records sr ON sr.contract_version_id=cv.id
JOIN contract_parties cp ON cp.id=sr.contract_party_id AND cp.contract_id=cv.contract_id
JOIN signature_requests req ON req.id=sr.signature_request_id AND req.contract_version_id=cv.id AND req.contract_party_id=cp.id AND req.status='signed'
WHERE cv.status IN ('issued','executed') AND cv.document_hash IS NOT NULL AND LENGTH(cv.document_hash)=64 AND f.sha256_hash=cv.document_hash AND f.status='active'
GROUP BY cv.contract_id, cv.id, cv.public_id, cv.version_number, cv.document_hash, f.id, f.storage_key, f.storage_provider, f.sha256_hash, f.size_bytes, f.mime_type
HAVING COUNT(*)=2 AND SUM(CASE WHEN cp.party_role='tenant' AND sr.document_hash=cv.document_hash THEN 1 ELSE 0 END)=1
AND SUM(CASE WHEN cp.party_role='landlord' AND sr.document_hash=cv.document_hash THEN 1 ELSE 0 END)=1
AND (SELECT COUNT(*) FROM signature_records other_sr JOIN contract_versions other_cv ON other_cv.id=other_sr.contract_version_id WHERE other_cv.contract_id=cv.contract_id)=2
) b ON b.contract_id=c.id
SET c.signed_version_id=b.version_id, c.signed_document_hash=b.document_hash
WHERE c.status='executed';
