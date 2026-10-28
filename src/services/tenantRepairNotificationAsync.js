// 報修外部頁在 TiDB 模式下的通知入口。舊的 tenantRepairLineService 使用同步
// better-sqlite3 repository，不能把 MySQL driver 丟進去，否則案件本身雖存雲端、
// 通知卻會在 push 前因同步查詢而中斷。
const repairs = require('../repositories/v2RepairRepositoryAsync');
const notifications = require('./v2NotificationEventServiceAsync');
const dashboardPresenter = require('./dashboardLinePresenter');

async function notifyLandlordsForNewRepair(db, lineClient, ticket, context) {
  const recipients = await repairs.listLandlordRecipients(db, ticket.rental_unit_id);
  const files = await repairs.listRepairFiles(db, ticket.public_id);
  for (const recipient of recipients) {
    const card = dashboardPresenter.dashboardRepairDetailCard({
      ...ticket,
      unit_label: context.unitLabel,
      tenant_name: context.tenantName,
      tenant_repair_preference: context.tenantRepairPreference,
      files,
    }, recipient.scope || 'unit_owner', recipient.line_user_id, {
      title: '🛠️ 房客完成報修送出',
      subtitle: '房東端通知｜新報修已送出，請處理並查看',
      tag: '房東端',
      enableRecommendationChoices: false,
    });
    try {
      await notifications.recordNotificationDelivery({
        db,
        lineClient,
        message: card,
        notification: {
          publicId: `notif-repair-reported-${ticket.public_id}`,
          eventType: 'repair_reported',
          entityType: 'repair_ticket',
          entityId: ticket.public_id,
          templateCode: 'line_repair_ticket',
          payload: { ticketPublicId: ticket.public_id, unitLabel: context.unitLabel, tenantName: context.tenantName, status: ticket.status },
        },
        recipient: { userId: recipient.user_id, lineIdentityId: recipient.line_identity_id, lineUserId: recipient.line_user_id },
        idempotencyKey: `repair_reported:${ticket.public_id}:landlord:${recipient.user_id}:line`,
      });
    } catch (error) {
      // 推播失敗不能讓房客誤以為案件沒建成；failed delivery 與 attempt 已持久化，
      // 後續 retry worker 可以依此重送。
      console.error('Failed to notify cloud repair ticket landlord:', error.message);
    }
  }
  return recipients.length;
}

async function notifyLandlordsForRepairUpdate(db, lineClient, ticket, context = {}) {
  const recipients = await repairs.listLandlordRecipients(db, ticket.rental_unit_id);
  const files = await repairs.listRepairFiles(db, ticket.public_id);
  for (const recipient of recipients) {
    const card = dashboardPresenter.dashboardRepairDetailCard({ ...ticket, files }, recipient.scope || 'unit_owner', recipient.line_user_id, {
      title: context.title || '🛠️ 報修案件有新進度', subtitle: context.subtitle || '請到外部頁查看完整紀錄並處理',
      tag: context.tag || '房東端', summary: context.summary, enableRecommendationChoices: false,
    });
    try {
      await notifications.recordNotificationDelivery({
        db, lineClient, message: card,
        notification: { publicId: `notif-repair-${context.eventKey || 'updated'}-${ticket.public_id}`,
          eventType: 'repair_status_updated', entityType: 'repair_ticket', entityId: ticket.public_id,
          templateCode: 'line_repair_status', payload: { ticketPublicId: ticket.public_id, eventKey: context.eventKey || 'updated' } },
        recipient: { userId: recipient.user_id, lineIdentityId: recipient.line_identity_id, lineUserId: recipient.line_user_id },
        idempotencyKey: `repair_${context.eventKey || 'updated'}:${ticket.public_id}:landlord:${recipient.user_id}:line`,
      });
    } catch (error) { console.error('Failed to notify cloud repair update landlord:', error.message); }
  }
}

async function notifyTenantForRepairUpdate(db, lineClient, ticket, message, eventKey) {
  if (!ticket?.tenant_line_user_id) return;
  try {
    await notifications.recordNotificationDelivery({
      db, lineClient, message,
      notification: { publicId: `notif-repair-tenant-${eventKey}-${ticket.public_id}`,
        eventType: 'repair_status_updated', entityType: 'repair_ticket', entityId: ticket.public_id,
        templateCode: 'line_repair_status', payload: { ticketPublicId: ticket.public_id, eventKey } },
      recipient: { userId: ticket.tenant_user_id, lineIdentityId: ticket.tenant_line_identity_id, lineUserId: ticket.tenant_line_user_id },
      idempotencyKey: `repair_${eventKey}:${ticket.public_id}:tenant:${ticket.tenant_user_id}:line`,
    });
  } catch (error) { console.error('Failed to notify cloud repair tenant:', error.message); }
}

module.exports = { notifyLandlordsForNewRepair, notifyLandlordsForRepairUpdate, notifyTenantForRepairUpdate };
