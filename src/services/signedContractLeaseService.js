const crypto = require('node:crypto');

const sourceSql = `SELECT c.rental_unit_id, cv.condition_snapshot_json FROM contracts c
  JOIN contract_versions cv ON cv.contract_id=c.id AND cv.id=c.signed_version_id
  WHERE c.id=? AND cv.id=? AND c.status='executed' AND c.signed_document_hash=cv.document_hash`;
const partiesSql = `SELECT cp.id, cp.user_id, cp.party_role FROM signature_records sr
  JOIN contract_parties cp ON cp.id=sr.contract_party_id AND cp.contract_id=?
  JOIN contract_versions cv ON cv.id=sr.contract_version_id
  WHERE sr.contract_version_id=? AND sr.document_hash=cv.document_hash AND cp.status='active'`;

function values(source, parties) {
  let snapshot;
  try { snapshot = JSON.parse(source?.condition_snapshot_json); } catch { return null; }
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const start = snapshot?.leaseStartDate, end = snapshot?.leaseEndDate;
  if (!source?.rental_unit_id || !validDate(start) || !validDate(end) || end < start || parties.length !== 2 ||
      !parties.every(p => p.user_id && ['tenant', 'landlord'].includes(p.party_role)) ||
      new Set(parties.map(p => p.party_role)).size !== 2) return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return { start, end, status: today < start ? 'scheduled' : today > end ? 'ended' : 'active' };
}

function create(db, contractId, versionId) {
  if (db.prepare('SELECT id FROM leases WHERE contract_id=?').get(contractId)) return;
  const source = db.prepare(sourceSql).get(contractId, versionId);
  const parties = db.prepare(partiesSql).all(contractId, versionId);
  const lease = values(source, parties);
  if (!lease) return;
  const result = db.prepare('INSERT INTO leases (public_id,contract_id,rental_unit_id,start_date,end_date,status) VALUES (?,?,?,?,?,?)').run(`lease-${crypto.randomUUID()}`, contractId, source.rental_unit_id, lease.start, lease.end, lease.status);
  for (const p of parties) db.prepare('INSERT INTO lease_parties (lease_id,contract_party_id,user_id,party_role,effective_from) VALUES (?,?,?,?,?)').run(result.lastInsertRowid, p.id, p.user_id, p.party_role, lease.start);
}

async function createAsync(db, contractId, versionId) {
  if (await db.get('SELECT id FROM leases WHERE contract_id=?', [contractId])) return;
  const source = await db.get(sourceSql, [contractId, versionId]);
  const parties = await db.all(partiesSql, [contractId, versionId]);
  const lease = values(source, parties);
  if (!lease) return;
  const result = await db.run('INSERT INTO leases (public_id,contract_id,rental_unit_id,start_date,end_date,status) VALUES (?,?,?,?,?,?)', [`lease-${crypto.randomUUID()}`, contractId, source.rental_unit_id, lease.start, lease.end, lease.status]);
  for (const p of parties) await db.run('INSERT INTO lease_parties (lease_id,contract_party_id,user_id,party_role,effective_from) VALUES (?,?,?,?,?)', [result.insertId, p.id, p.user_id, p.party_role, lease.start]);
}

module.exports = { create, createAsync };
