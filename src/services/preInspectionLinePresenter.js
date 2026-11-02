const { createPreInspectionToken } = require('./preInspectionTokenService');
const { liffUrl } = require('./liffSessionService');

// 房東的點交確認直接開外部頁：所有房東都能查看設備、照片與備註，並在
// 同一頁完成確認，不受 Developing Mini App 的 developer 身分限制。
function externalUrl(path) {
  const normalizedPath = String(path || '').startsWith('/') ? String(path) : `/${String(path || '')}`;
  const baseUrl = (process.env.WEB_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  return `${baseUrl}${normalizedPath}`;
}


function preInspectionSummaryCard(session, stats, supplementCount, context = {}) {
  const dateStr = session.started_at ? session.started_at.split('T')[0] : '未知日期';
  const title = session.title || '目前房源';
  const displaySupplementCount = supplementCount || 0;

  const landlordName = context.landlordName || '系統設定';
  const addressText = context.addressText || '未提供地點';

  const lineUserId = (session && session.line_user_id) || context.lineUserId || '';
  const publicId = session && session.public_id;
  if (!publicId) {
    console.error('[preInspectionLinePresenter] Missing session public_id in preInspectionSummaryCard');
    throw new Error('Missing session public_id for preInspectionSummaryCard');
  }
  const token = createPreInspectionToken(lineUserId, publicId);
  if (!token) {
    console.error('[preInspectionLinePresenter] Failed to create token in preInspectionSummaryCard');
    throw new Error('Failed to create preInspectionToken for preInspectionSummaryCard');
  }
  const viewPath = `/tenant/pre-inspections/${publicId}?token=${encodeURIComponent(token)}`;
  const viewUrl = liffUrl(viewPath);

  return {
    type: 'flex',
    altText: `入住前屋況紀錄｜${dateStr}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0F766E',
        paddingAll: 'xl',
        contents: [
          {
            type: 'text',
            text: '入住前屋況紀錄',
            weight: 'bold',
            size: 'xl',
            color: '#ffffff'
          },
          {
            type: 'text',
            text: '待房東確認',
            size: 'xs',
            color: '#A7E5D7',
            margin: 'sm'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'xl',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              {
                type: 'text',
                text: title,
                weight: 'bold',
                size: 'md',
                wrap: true,
                color: '#111827'
              },
              {
                type: 'text',
                text: addressText,
                size: 'xs',
                color: '#64748B',
                wrap: true
              },
              {
                type: 'text',
                text: `房東：${landlordName} ｜ 日期：${dateStr}`,
                size: 'xs',
                color: '#64748B'
              }
            ]
          },
          {
            type: 'separator',
            margin: 'lg',
            color: '#E5E7EB'
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'lg',
            spacing: 'sm',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'md',
                contents: [
                  {
                    type: 'box',
                    layout: 'vertical',
                    alignItems: 'center',
                    contents: [
                      { type: 'text', text: '照片', size: 'xs', color: '#64748B' },
                      { type: 'text', text: String(stats.imageCount), size: 'md', weight: 'bold', color: '#0F766E' }
                    ]
                  },
                  {
                    type: 'box',
                    layout: 'vertical',
                    alignItems: 'center',
                    contents: [
                      { type: 'text', text: '影片', size: 'xs', color: '#64748B' },
                      { type: 'text', text: String(stats.videoCount), size: 'md', weight: 'bold', color: '#0F766E' }
                    ]
                  },
                  {
                    type: 'box',
                    layout: 'vertical',
                    alignItems: 'center',
                    contents: [
                      { type: 'text', text: '備註', size: 'xs', color: '#64748B' },
                      { type: 'text', text: String(stats.textCount), size: 'md', weight: 'bold', color: '#0F766E' }
                    ]
                  },
                  {
                    type: 'box',
                    layout: 'vertical',
                    alignItems: 'center',
                    contents: [
                      { type: 'text', text: '補充', size: 'xs', color: '#64748B' },
                      { type: 'text', text: String(displaySupplementCount), size: 'md', weight: 'bold', color: '#0F766E' }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'lg',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#0F766E',
            action: {
              type: 'uri',
              label: '查看內容',
              uri: viewUrl
            }
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'postback',
              label: '新增補充',
              data: `action=tenant_pre_inspection_start&parent_id=${session.id}`
            }
          },
          ...(session.confirmation_status === 'pending_landlord_confirmation' ? [{
            type: 'text',
            text: '已送交房東確認',
            color: '#9CA3AF',
            size: 'sm',
            align: 'center',
            margin: 'md'
          }] : session.confirmation_status === 'landlord_confirmed' ? [{
            type: 'text',
            text: '狀態：房東已確認',
            color: '#10B981',
            size: 'sm',
            align: 'center',
            margin: 'md',
            weight: 'bold'
          }] : [
            {
              type: 'button',
              style: 'primary',
              color: '#1D4ED8',
              action: {
                type: 'postback',
                label: '送交房東確認',
                data: `action=tenant_pre_inspection_submit&id=${session.id}`
              }
            },
            {
              type: 'button',
              style: 'secondary',
              color: '#EF4444',
              action: {
                type: 'postback',
                label: '移除紀錄包',
                data: `action=tenant_pre_inspection_delete_confirm&id=${session.id}`
              }
            }
          ])
        ]
      }
    }
  };
}

function preInspectionLandlordCard(session, stats, supplementCount, context = {}) {
  const d = session.started_at ? new Date(session.started_at) : new Date();
  const dateStr = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  const title = session.title || '目前房源';
  const tenantName = context.tenantName || '房客';
  // 合約送簽被擋下來而轉交審閱時,房東要知道「為什麼現在要看這一份」——
  // 這關係到對方的合約能不能往下走,和房客隨手送交確認不是同一件事。
  const noteText = context.noteText || null;
  // 房東不能使用房客的點交連結。每張房東卡都要綁定接收該卡的房東本人，
  // 後端仍會再以 property_owners 驗證他是否確實擁有此房源。
  return {
    type: 'flex',
    altText: `【串接】入住前屋況紀錄待確認｜${dateStr}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'none',
        paddingAll: '0px',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            width: '6px',
            backgroundColor: '#F59E0B',
            contents: [{ type: 'filler' }]
          },
          {
            type: 'box',
            layout: 'vertical',
            paddingAll: 'lg',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                alignItems: 'center',
                spacing: 'sm',
                contents: [
                  {
                    type: 'text',
                    text: '入住前屋況紀錄',
                    weight: 'bold',
                    size: 'sm',
                    color: '#111827',
                    flex: 1
                  },
                  {
                    type: 'box',
                    layout: 'vertical',
                    backgroundColor: '#FEF3C7',
                    paddingStart: 'sm',
                    paddingEnd: 'sm',
                    paddingTop: 'xs',
                    paddingBottom: 'xs',
                    cornerRadius: 'sm',
                    contents: [
                      {
                        type: 'text',
                        text: '待確認',
                        size: 'xxs',
                        color: '#D97706',
                        weight: 'bold'
                      }
                    ]
                  }
                ]
              },
              {
                type: 'text',
                text: `${tenantName} 已送交 ${title} 的入住前屋況紀錄。`,
                size: 'xs',
                color: '#4B5563',
                wrap: true,
                margin: 'md'
              },
              ...(noteText ? [{
                type: 'text',
                text: noteText,
                size: 'xs',
                color: '#B45309',
                weight: 'bold',
                wrap: true,
                margin: 'sm'
              }] : []),
              {
                type: 'text',
                text: `照片 ${stats.imageCount || 0} 張、影片 ${stats.videoCount || 0} 支、備註 ${stats.textCount || 0} 則`,
                size: 'xxs',
                color: '#6B7280',
                margin: 'md'
              },
              {
                type: 'text',
                text: `送交時間：${dateStr}`,
                size: 'xxs',
                color: '#9CA3AF',
                margin: 'xs'
              }
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        paddingAll: 'md',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'uri',
              label: '查看並確認',
              uri: (() => {
                const landlordUserId = context.landlordLineUserId || '';
                const publicId = session && session.public_id;
                if (!publicId) {
                  console.error('[preInspectionLinePresenter] Missing session public_id in preInspectionLandlordCard');
                  throw new Error('Missing session public_id for preInspectionLandlordCard');
                }
                const token = createPreInspectionToken(landlordUserId, publicId);
                if (!token) {
                  console.error('[preInspectionLinePresenter] Failed to create token in preInspectionLandlordCard');
                  throw new Error('Failed to create preInspectionToken for preInspectionLandlordCard');
                }
                return externalUrl(`/tenant/pre-inspections/${publicId}?token=${encodeURIComponent(token)}`);
              })()
            }
          }
        ]
      }
    }
  };
}

function getViewUrl(options = {}) {
  if (options && options.viewUrl) return options.viewUrl;
  const session = options && options.session;
  const publicId = options.publicId || (session && session.public_id);
  const lineUserId = options.lineUserId || (session && session.line_user_id) || '';

  if (!publicId) {
    console.error('[preInspectionLinePresenter] Missing session public_id in getViewUrl');
    throw new Error('Missing session public_id for getViewUrl');
  }

  const token = createPreInspectionToken(lineUserId, publicId);
  if (!token) {
    console.error('[preInspectionLinePresenter] Failed to create token in getViewUrl');
    throw new Error('Failed to create preInspectionToken for getViewUrl');
  }

  const path = `/tenant/pre-inspections/${publicId}?token=${encodeURIComponent(token)}`;
  return liffUrl(path);
}

function startPreInspectionCard(title, options = {}) {
  const opts = typeof options === 'object' && !Array.isArray(options) ? options : {};
  const viewUrl = getViewUrl(opts);
  const rawItems = opts.equipmentItems || (Array.isArray(options) ? options : []);
  const equipmentText = Array.isArray(rawItems) && rawItems.length > 0
    ? rawItems.join('、')
    : '無設備資料';

  const bodyContents = [
    { type: 'text', text: '📝 屋況紀錄已開啟', weight: 'bold', size: 'lg', color: '#0F766E' },
    { type: 'text', text: `已為「${title}」開啟入住前屋況紀錄。`, size: 'sm', wrap: true, color: '#1F2937' },
    { type: 'text', text: `📋 房源設備參考：\n${equipmentText}`, size: 'xs', wrap: true, color: '#0F766E', margin: 'md' },
    { type: 'text', text: '請上傳想保留的屋況照片、影片，或直接輸入文字備註。\n\n💡 若有明顯瑕疵、設備異常或容易產生爭議的地方，建議優先記錄。', size: 'xs', wrap: true, color: '#6B7280', margin: 'md' }
  ];

  return {
    type: 'flex',
    altText: `開啟入住前屋況紀錄 - ${title}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'lg', spacing: 'md',
        contents: bodyContents
      },
      footer: {
        type: 'box', layout: 'vertical', paddingStart: 'lg', paddingEnd: 'lg', paddingBottom: 'lg', spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'uri',
              label: '查看目前紀錄',
              uri: viewUrl
            }
          },
          {
            type: 'button',
            style: 'primary',
            color: '#0F766E',
            height: 'sm',
            action: {
              type: 'postback',
              label: '完成紀錄',
              data: `action=tenant_pre_inspection_finish&session_id=${encodeURIComponent(opts.session.public_id)}`
            }
          },
          {
            type: 'button',
            style: 'secondary',
            color: '#EF4444',
            height: 'sm',
            action: {
              type: 'postback',
              label: '放棄本次紀錄',
              data: 'action=tenant_pre_inspection_cancel_active'
            }
          }
        ]
      }
    }
  };
}

function addedToRecordCard(stats, options = {}) {
  const opts = typeof options === 'object' && !Array.isArray(options) ? options : {};
  const viewUrl = getViewUrl(opts);
  return {
    type: 'flex',
    altText: `已加入本次紀錄`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'lg', spacing: 'md',
        contents: [
          { type: 'text', text: '✅ 已加入本次紀錄', weight: 'bold', size: 'md', color: '#10B981' },
          { type: 'text', text: `目前已保存 ${stats.imageCount} 張照片、${stats.videoCount} 支影片、${stats.textCount} 則備註。`, size: 'sm', wrap: true, color: '#4B5563' },
          { type: 'text', text: '您可以繼續上傳，或點選下方按鈕完成。', size: 'xs', wrap: true, color: '#9CA3AF' }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', paddingStart: 'lg', paddingEnd: 'lg', paddingBottom: 'lg', spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'uri',
              label: '查看目前紀錄',
              uri: viewUrl
            }
          },
          { type: 'button', style: 'primary', color: '#0F766E', height: 'sm', action: { type: 'postback', label: '完成紀錄', data: `action=tenant_pre_inspection_finish&session_id=${encodeURIComponent(opts.session.public_id)}` } }
        ]
      }
    }
  };
}

function sealedRecordCard(title, dateStr, stats) {
  return {
    type: 'flex',
    altText: `入住前屋況紀錄已封存`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'lg', spacing: 'sm',
        contents: [
          { type: 'text', text: '🔒 紀錄已封存', weight: 'bold', size: 'lg', color: '#374151' },
          { type: 'text', text: `房源：${title}`, size: 'sm', wrap: true, color: '#4B5563' },
          { type: 'text', text: `日期：${dateStr}`, size: 'sm', color: '#4B5563' },
          { type: 'text', text: `內容：${stats.imageCount} 照片 / ${stats.videoCount} 影片 / ${stats.textCount} 備註`, size: 'sm', color: '#4B5563' },
          { type: 'text', text: '狀態：待送交房東確認', size: 'sm', color: '#D97706', weight: 'bold', margin: 'md' }
        ]
      }
    }
  };
}

function startSupplementCard(dateStr, options = {}) {
  const opts = typeof options === 'object' && !Array.isArray(options) ? options : {};
  const viewUrl = getViewUrl(opts);
  return {
    type: 'flex',
    altText: `已開啟補充紀錄`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'lg', spacing: 'md',
        contents: [
          { type: 'text', text: '📝 已開啟補充紀錄', weight: 'bold', size: 'lg', color: '#2563EB' },
          { type: 'text', text: `這份補充內容會連到『入住前屋況紀錄｜${dateStr}』。`, size: 'sm', wrap: true, color: '#1F2937' },
          { type: 'text', text: '請上傳要補充的照片、影片，或輸入文字備註。', size: 'xs', wrap: true, color: '#6B7280' }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', paddingStart: 'lg', paddingEnd: 'lg', paddingBottom: 'lg', spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'uri',
              label: '查看目前紀錄',
              uri: viewUrl
            }
          },
          { type: 'button', style: 'primary', color: '#2563EB', height: 'sm', action: { type: 'postback', label: '完成補充', data: `action=tenant_pre_inspection_finish&session_id=${encodeURIComponent(opts.session.public_id)}` } },
          {
            type: 'button',
            style: 'secondary',
            color: '#EF4444',
            height: 'sm',
            action: {
              type: 'postback',
              label: '放棄本次紀錄',
              data: 'action=tenant_pre_inspection_cancel_active'
            }
          }
        ]
      }
    }
  };
}

function sealedSupplementCard(dateStr, stats) {
  return {
    type: 'flex',
    altText: `補充紀錄已封存`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'lg', spacing: 'sm',
        contents: [
          { type: 'text', text: '🔒 補充紀錄已封存', weight: 'bold', size: 'lg', color: '#374151' },
          { type: 'text', text: `已連結至：入住前屋況紀錄｜${dateStr}`, size: 'sm', wrap: true, color: '#4B5563' },
          { type: 'text', text: `內容：${stats.imageCount} 照片 / ${stats.videoCount} 影片 / ${stats.textCount} 備註`, size: 'sm', color: '#4B5563' },
          { type: 'text', text: '💡 之後可從『屋況點交』一起查看。', size: 'xs', color: '#9CA3AF', margin: 'md', wrap: true }
        ]
      }
    }
  };
}

function sentToLandlordCard() {
  return {
    type: 'flex',
    altText: `已送交房東確認`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'lg', spacing: 'md', alignItems: 'center',
        contents: [
          { type: 'text', text: '📤 已送交房東確認', weight: 'bold', size: 'lg', color: '#0F766E' },
          { type: 'text', text: '房東查看後，系統會通知確認結果。', size: 'sm', color: '#6B7280', wrap: true, align: 'center' }
        ]
      }
    }
  };
}

function deleteConfirmCard(sessionId) {
  return {
    type: 'flex',
    altText: '確認移除屋況紀錄包',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'lg', spacing: 'md',
        contents: [
          { type: 'text', text: '⚠️ 確定要移除此紀錄包嗎？', weight: 'bold', size: 'lg', color: '#EF4444' },
          { type: 'text', text: '移除後該紀錄包將改為已取消狀態，且不再顯示於屋況點交列表中。相關補充紀錄也將一併移除。', size: 'sm', wrap: true, color: '#374151' }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', paddingStart: 'lg', paddingEnd: 'lg', paddingBottom: 'lg', spacing: 'sm',
        contents: [
          {
            type: 'button', style: 'primary', color: '#EF4444',
            action: { type: 'postback', label: '確認移除', data: `action=tenant_pre_inspection_delete&id=${sessionId}` }
          },
          {
            type: 'button', style: 'secondary',
            action: { type: 'postback', label: '暫時不要', data: 'action=tenant_pre_inspection_delete_cancel' }
          }
        ]
      }
    }
  };
}

function selectListingForInspectionCard(confirmedAppointments, liffUrl, options = {}) {
  const isSingle = confirmedAppointments.length === 1;
  const hasSealed = !!options.hasSealed;

  const buttons = confirmedAppointments.slice(0, 5).map(inq => {
    const rawTitle = inq.listing_title || '房源';
    const labelTitle = rawTitle.length > 14 ? rawTitle.slice(0, 13) + '…' : rawTitle;
    return {
      type: 'button',
      style: 'primary',
      color: '#0F766E',
      height: 'sm',
      action: {
        type: 'postback',
        label: isSingle ? `開始點交【${labelTitle}】` : `點交【${labelTitle}】`,
        data: `action=tenant_pre_inspection_start&appointment_id=${inq.appointment_public_id}`
      }
    };
  });

  if (hasSealed) {
    buttons.push({
      type: 'button',
      style: 'secondary',
      height: 'sm',
      action: {
        type: 'postback',
        label: '查看點交紀錄包',
        data: 'action=tenant_pre_inspection_list'
      }
    });
  }

  if (liffUrl) {
    buttons.push({
      type: 'button',
      style: 'secondary',
      height: 'sm',
      action: {
        type: 'uri',
        label: '開啟完整房源列表',
        uri: liffUrl
      }
    });
  }

  const bodyText = isSingle
    ? `房東已同意您看房：\n【${confirmedAppointments[0].listing_title || '房源'}】\n點選下方按鈕開始記錄入住前屋況。`
    : `您有 ${confirmedAppointments.length} 筆已核准的看房預約，請選擇欲進行屋況點交的房屋：`;

  return {
    type: 'flex',
    altText: '選擇屋況點交房源',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0F766E',
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: isSingle ? '📋 開始屋況點交' : '📋 請選擇要點交的房源', color: '#FFFFFF', weight: 'bold', size: 'md' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: bodyText, size: 'sm', color: '#374151', wrap: true }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: buttons
      }
    }
  };
}

function submitConfirmCard(sessionId) {
  return {
    type: 'flex',
    altText: '確認送交房東確認',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        spacing: 'md',
        contents: [
          { type: 'text', text: '📤 送交房東確認', weight: 'bold', size: 'lg', color: '#1D4ED8' },
          { type: 'text', text: '您確定要將此份入住前屋況紀錄送交房東確認嗎？\n\n送出後系統將會通知房東查看，此紀錄狀態將變更為『待房東確認』。', size: 'sm', wrap: true, color: '#374151' }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', paddingStart: 'lg', paddingEnd: 'lg', paddingBottom: 'lg', spacing: 'sm',
        contents: [
          {
            type: 'button', style: 'primary', color: '#1D4ED8', height: 'sm',
            action: { type: 'postback', label: '確認送出', data: `action=tenant_pre_inspection_submit_confirm&id=${sessionId}` }
          },
          {
            type: 'button', style: 'secondary', height: 'sm',
            action: { type: 'postback', label: '暫時不要', data: 'action=tenant_pre_inspection_submit_cancel' }
          }
        ]
      }
    }
  };
}

// 房東端不依賴推播的落點之一:輸入「屋況點交」就會先看到還有幾份等自己審閱。
// 推播額度用完(429)時,這是房東唯一能主動查到待審閱清單的地方,所以摘要要說得出
// 「幾份、什麼時候送的」,不能只丟一句「有待辦」。
function landlordPendingReviewSummaryCard(sessions, options = {}) {
  const count = sessions.length;
  const fromContract = Number(options.contractCount || 0);
  const lines = [
    { type: 'text', text: `目前有 ${count} 份入住前屋況紀錄等您審閱。`, size: 'sm', color: '#374151', wrap: true }
  ];
  if (fromContract > 0) {
    lines.push({
      type: 'text',
      text: `其中 ${fromContract} 份是房客送出合約簽署時附上的附件一，房東確認後房客才能繼續簽約。`,
      size: 'xs',
      color: '#B45309',
      wrap: true,
      margin: 'sm'
    });
  }
  lines.push({
    type: 'text',
    text: '請在下方每一張卡片點「查看內容」後按「確認已查看」。',
    size: 'xs',
    color: '#6B7280',
    wrap: true,
    margin: 'md'
  });

  return {
    type: 'flex',
    altText: `有 ${count} 份屋況紀錄等您審閱`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#B45309',
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: '🔎 待審閱屋況紀錄', color: '#FFFFFF', weight: 'bold', size: 'md' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'none',
        contents: lines
      }
    }
  };
}

// 房東確認完最後一份附件之後,房客要知道「現在可以送簽了」。推播是加分項,
// 草稿頁本身也會顯示同一件事,所以這張卡片失敗不影響流程。
function conditionReviewClearedCard(contractPublicId, options = {}) {
  const draftUrl = liffUrl(`/v2/contracts/${contractPublicId}/drafts`);
  const title = options.title || '入住前屋況紀錄';
  return {
    type: 'flex',
    altText: '房東已確認屋況附件，可以送出簽署',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        spacing: 'md',
        contents: [
          { type: 'text', text: '✅ 房東已確認屋況附件', weight: 'bold', size: 'lg', color: '#0F766E' },
          { type: 'text', text: `「${title}」已由房東確認，合約附件一不再有待審閱的紀錄。`, size: 'sm', color: '#374151', wrap: true },
          { type: 'text', text: '回到合約草稿頁就可以按「以此版本進行簽署」。', size: 'xs', color: '#6B7280', wrap: true }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingStart: 'lg',
        paddingEnd: 'lg',
        paddingBottom: 'lg',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#0F766E',
            action: { type: 'uri', label: '回合約草稿頁', uri: draftUrl }
          }
        ]
      }
    }
  };
}

module.exports = {
  preInspectionSummaryCard,
  preInspectionLandlordCard,
  landlordPendingReviewSummaryCard,
  conditionReviewClearedCard,
  startPreInspectionCard,
  selectListingForInspectionCard,
  addedToRecordCard,
  sealedRecordCard,
  startSupplementCard,
  sealedSupplementCard,
  sentToLandlordCard,
  deleteConfirmCard,
  submitConfirmCard
};
