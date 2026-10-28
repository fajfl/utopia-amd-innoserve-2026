// 續約功能的 LINE Flex Message 產生器。純函式,不查資料庫、不呼叫 LINE API——
// 資料一律由呼叫端(postback handler 或 dispatcher)先查好再傳進來,方便測試。
//
// 視覺沿用 tenantFeatureLineService.js 既有的配色慣例(主色 #0F766E、內文
// #4B5563),不是我先前規劃階段那份 mockup 自己的配色——這裡是真的會出現在
// LINE 對話裡的訊息,要跟其他既有卡片一致,不要自己另外開一套風格。

const ACCENT = '#0F766E';
const LANDLORD_ACCENT = '#2563EB';
const LANDLORD_BACKGROUND = '#EFF6FF';
const TENANT_ACCENT = '#15803D';
const TENANT_BACKGROUND = '#F0FDF4';
const BODY_TEXT = '#4B5563';
const MUTED_TEXT = '#6B7280';
const WARN_BG = '#FEF3C7';
const WARN_TEXT = '#B45309';

function money(amount) {
  if (amount === null || amount === undefined) return '未提供';
  return `NT$${Number(amount).toLocaleString('zh-Hant-TW')}`;
}

function renewalAction({ label, displayText = label, action, extra = {} }) {
  return {
    type: 'postback',
    label,
    data: new URLSearchParams({ action, ...extra }).toString(),
    displayText
  };
}

// 純資訊型的按鈕,不觸發任何 postback——目前唯一用途是「查看目前合約」,
// 連到合約管理中心(既有的 cardMessageService.contractsUrl()),讓使用者在
// 決定要不要沿用條件之前,能回頭看一次完整合約內容,不是只能相信卡片上
// 摘要的那一兩個數字。呼叫端不給 uri 時,對應按鈕就不會出現。
function linkAction({ label, uri }) {
  return { type: 'uri', label, uri };
}

function bubble({
  title, lines = [], buttons = [], titleColor = ACCENT,
  backgroundColor = '#FFFFFF', buttonColors = [], buttonStyles = []
}) {
  return {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      backgroundColor,
      contents: [
        { type: 'text', text: title, weight: 'bold', size: 'lg', color: titleColor, wrap: true },
        ...lines.map((line) => {
          // line 可能是純字串,也可能是 { text, small, color } 這種帶樣式的寫法
          // (例如小字提示)。之前這裡沒分辨,物件寫法會把整個物件塞進 LINE 卡片
          // 的 text 欄位——LINE 要求 text 必須是字串,收到物件會直接 400 拒收,
          // 這是 2026-09-21 實測時發現的:Q1/Q2/提案卡都用了物件寫法的小字提示,
          // 第一次點「開始確認續約」拿到 Q1 卡就整個炸掉,回不了 reply。
          const isStyled = line && typeof line === 'object';
          return {
            type: 'text',
            text: isStyled ? line.text : line,
            size: isStyled && line.small ? 'xs' : 'sm',
            color: (isStyled && line.color) || BODY_TEXT,
            wrap: true,
            margin: 'sm'
          };
        })
      ]
    },
    footer: buttons.length ? {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      backgroundColor,
      contents: buttons.map((button, index) => {
        const isLink = button.type === 'uri';
        const buttonColor = buttonColors[index];
        const buttonStyle = buttonStyles[index];
        return {
          type: 'button',
          style: isLink ? 'link' : (buttonStyle || (buttonColor || index === 0 ? 'primary' : 'secondary')),
          height: 'sm',
          color: !isLink ? (buttonColor || (index === 0 ? titleColor : undefined)) : undefined,
          action: button
        };
      })
    } : undefined
  };
}

// 沒有 active 租約時,不是報錯,是清楚告訴使用者現在沒有可以續約的租約。
function noActiveLeaseMessage() {
  return {
    type: 'text',
    text: '目前沒有可辦理續約的租約。這份租約可能已完成續約，或房東已確認不續約；若你覺得狀態不對，請聯繫客服協助確認。'
  };
}

function renewalHomeCard({ roles = [], contractsUrl }) {
  const uniqueRoles = [...new Set(roles)];
  const buttons = [];
  const buttonColors = [];
  if (uniqueRoles.includes('tenant')) {
    buttons.push(renewalAction({
      label: '提出續約申請',
      action: 'renewal_choose_lease',
      extra: { role: 'tenant' }
    }));
    buttonColors.push(TENANT_ACCENT);
  }
  if (uniqueRoles.includes('landlord')) {
    buttons.push(renewalAction({ label: '管理續約', action: 'renewal_landlord_menu' }));
    buttonColors.push(LANDLORD_ACCENT);
  }
  if (contractsUrl) buttons.push(linkAction({ label: '查看目前合約', uri: contractsUrl }));
  return {
    type: 'flex',
    altText: '續約服務',
    contents: bubble({
      title: '續約服務',
      lines: ['請選擇這次要辦理的項目。'],
      buttons,
      buttonColors
    })
  };
}

function landlordRenewalMenuCard() {
  const explanations = [
    {
      label: '待處理續約',
      description: '回覆房客提出的申請',
      backgroundColor: '#DBEAFE',
      color: '#1D4ED8'
    },
    {
      label: '提出續約方案',
      description: '選擇租約並設定下一期條件',
      backgroundColor: '#FEF3C7',
      color: '#92400E'
    }
  ];
  const contents = bubble({
    title: '管理續約',
    buttons: [
      renewalAction({ label: '待處理續約', action: 'renewal_pending' }),
      renewalAction({
        label: '提出續約方案', action: 'renewal_choose_lease', extra: { role: 'landlord' }
      })
    ],
    titleColor: LANDLORD_ACCENT,
    backgroundColor: LANDLORD_BACKGROUND,
    buttonColors: [LANDLORD_ACCENT],
    buttonStyles: ['primary', 'secondary']
  });
  contents.body.contents.push(...explanations.map((item) => ({
    type: 'box',
    layout: 'horizontal',
    alignItems: 'center',
    spacing: 'sm',
    margin: 'md',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        width: '108px',
        backgroundColor: item.backgroundColor,
        cornerRadius: 'sm',
        paddingAll: 'xs',
        contents: [
          {
            type: 'text', text: item.label, size: 'xs', weight: 'bold',
            color: item.color, align: 'center', wrap: false
          }
        ]
      },
      {
        type: 'text', text: item.description, size: 'xs', color: BODY_TEXT,
        wrap: true, flex: 1
      }
    ]
  })));
  return {
    type: 'flex',
    altText: '管理續約',
    contents
  };
}

function renewalRulesCard({ unchangedTermsNegotiable = false } = {}) {
  const explanations = [
    {
      label: '目前設定',
      description: unchangedTermsNegotiable ? '原條件允許協商' : '原條件不開放協商',
      backgroundColor: '#DBEAFE',
      color: '#1D4ED8'
    },
    {
      label: '適用範圍',
      description: '名下所有完全沿用原合約條件的續約',
      backgroundColor: '#FEF3C7',
      color: '#92400E'
    },
    {
      label: '調整條件',
      description: '僅該房源本次開放房客提出一次修改，其他房源不受影響',
      backgroundColor: '#DCFCE7',
      color: '#166534'
    }
  ];
  const contents = bubble({
    title: '續約規則',
    buttons: [
      renewalAction({ label: '原條件不協商', action: 'renewal_set_preference', extra: { negotiable: '0' } }),
      renewalAction({ label: '原條件允許協商', action: 'renewal_set_preference', extra: { negotiable: '1' } }),
      renewalAction({ label: '返回續約管理', action: 'renewal_landlord_menu' })
    ],
    titleColor: LANDLORD_ACCENT,
    backgroundColor: LANDLORD_BACKGROUND,
    buttonStyles: ['secondary', 'secondary', 'secondary']
  });
  contents.body.contents.push(...explanations.map((item) => ({
    type: 'box',
    layout: 'horizontal',
    alignItems: 'center',
    spacing: 'sm',
    margin: 'md',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        width: '88px',
        backgroundColor: item.backgroundColor,
        cornerRadius: 'sm',
        paddingAll: 'xs',
        contents: [
          {
            type: 'text', text: item.label, size: 'xs', weight: 'bold',
            color: item.color, align: 'center', wrap: false
          }
        ]
      },
      {
        type: 'text', text: item.description, size: 'xs', color: BODY_TEXT,
        wrap: true, flex: 1
      }
    ]
  })));
  return {
    type: 'flex',
    altText: '續約規則',
    contents
  };
}

function renewalLeaseSelectionCarousel(leases, { role } = {}) {
  const bubbles = leases.slice(0, 10).map((lease) => {
    const roles = Array.isArray(lease.roles) ? lease.roles : [];
    const accent = roles.length === 1 && roles[0] === 'tenant' ? TENANT_ACCENT : LANDLORD_ACCENT;
    const backgroundColor = roles.length === 1 && roles[0] === 'tenant'
      ? TENANT_BACKGROUND
      : LANDLORD_BACKGROUND;
    const title = lease.listingTitle || lease.propertyLabel || '租賃中房源';
    const lines = [
      lease.propertyLabel && lease.propertyLabel !== title ? lease.propertyLabel : null,
      lease.tenantName ? `承租人：${lease.tenantName}` : null,
      lease.startDate && lease.endDate ? `租期：${lease.startDate} ～ ${lease.endDate}` : null,
      lease.rentAmount !== null && lease.rentAmount !== undefined
        ? `每月租金：${money(lease.rentAmount)}`
        : null
    ].filter(Boolean);
    return bubble({
      title,
      lines,
      buttons: [renewalAction({
        label: '選擇此租約',
        action: 'renewal_select_lease',
        extra: { lease: lease.leasePublicId, ...(role ? { role } : {}) }
      })],
      titleColor: accent,
      backgroundColor,
      buttonColors: [accent]
    });
  });
  return {
    type: 'flex',
    altText: '請選擇要處理續約的房源',
    contents: { type: 'carousel', contents: bubbles }
  };
}

function pendingRenewalCarousel(items) {
  const bubbles = items.slice(0, 10).map(({ lease, renewalRequestPublicId }) => bubble({
    title: lease.listingTitle || lease.propertyLabel || '待處理續約',
    lines: [
      lease.tenantName ? `承租人：${lease.tenantName}` : null,
      lease.startDate && lease.endDate ? `目前租期：${lease.startDate} ～ ${lease.endDate}` : null,
      lease.rentAmount !== null && lease.rentAmount !== undefined ? `每月租金：${money(lease.rentAmount)}` : null
    ].filter(Boolean),
    buttons: [renewalAction({ label: '查看續約進度', action: 'renewal_resume', extra: { id: renewalRequestPublicId } })],
    titleColor: LANDLORD_ACCENT,
    backgroundColor: LANDLORD_BACKGROUND,
    buttonColors: [LANDLORD_ACCENT]
  }));
  return {
    type: 'flex',
    altText: '待處理續約',
    contents: { type: 'carousel', contents: bubbles }
  };
}

// 手動觸發續約的第一張卡——文字指令「續約租約」或系統提醒都會走到這裡。
function renewalLandlordDecisionCard({
  renewalRequestPublicId, leasePublicId, listingTitle, tenantName, propertyLabel,
  currentRentAmount, currentDepositAmount, currentStartDate, currentEndDate,
  unchangedTermsNegotiable = false, contractsUrl
}) {
  const target = renewalRequestPublicId
    ? { id: renewalRequestPublicId }
    : { lease: leasePublicId, role: 'landlord' };
  const lines = [
    '請選擇這份租約接下來的處理方式。',
    listingTitle ? `房源：${listingTitle}` : null,
    tenantName ? `承租人：${tenantName}` : null,
    propertyLabel && propertyLabel !== listingTitle ? `租賃標的：${propertyLabel}` : null,
    currentStartDate && currentEndDate ? `目前租期：${currentStartDate} ～ ${currentEndDate}` : null,
    currentRentAmount !== null && currentRentAmount !== undefined ? `每月租金：${money(currentRentAmount)}` : null,
    currentDepositAmount !== null && currentDepositAmount !== undefined ? `押金：${money(currentDepositAmount)}` : null,
    { text: unchangedTermsNegotiable
      ? '目前規則：沿用原條件時允許協商。'
      : '目前規則：沿用原條件時不開放協商。', small: true, color: MUTED_TEXT },
    { text: '若調整租金、押金、租期或其他條件，本次續約會開放房客提出一次修改。', small: true, color: MUTED_TEXT }
  ].filter(Boolean);
  const buttons = [
    renewalAction({
      label: '沿用原條件續約', action: 'renewal_plan',
      extra: { ...target, mode: 'reuse' }
    }),
    renewalAction({
      label: '調整條件後續約', action: 'renewal_plan',
      extra: { ...target, mode: 'adjust' }
    }),
    renewalAction({ label: '不續約', action: 'renewal_decline_confirm', extra: target })
  ];
  if (contractsUrl) buttons.push(linkAction({ label: '查看目前合約', uri: contractsUrl }));
  return {
    type: 'flex',
    altText: '請選擇續約處理方式',
    contents: bubble({
      title: '續約處理',
      lines,
      buttons,
      titleColor: LANDLORD_ACCENT,
      backgroundColor: LANDLORD_BACKGROUND,
      buttonColors: [LANDLORD_ACCENT],
      buttonStyles: ['primary', 'secondary', 'secondary', 'secondary']
    })
  };
}

function renewalStartCard({
  leasePublicId, listingTitle, propertyLabel, tenantName, startDate, endDate,
  rentAmount, depositAmount, viewerRole, viewerRoles, contractsUrl
}) {
  const roles = Array.isArray(viewerRoles) && viewerRoles.length
    ? [...new Set(viewerRoles.filter((role) => role === 'landlord' || role === 'tenant'))]
    : [viewerRole].filter(Boolean);
  const dualRole = roles.includes('landlord') && roles.includes('tenant');
  if (!dualRole && roles[0] === 'landlord') {
    return renewalLandlordDecisionCard({
      leasePublicId,
      listingTitle,
      tenantName,
      propertyLabel,
      currentRentAmount: rentAmount,
      currentDepositAmount: depositAmount,
      currentStartDate: startDate,
      currentEndDate: endDate,
      contractsUrl
    });
  }
  if (!dualRole && roles[0] === 'tenant') {
    return renewalTenantPlanCard({
      leasePublicId,
      listingTitle,
      propertyLabel,
      startDate,
      endDate,
      rentAmount,
      depositAmount,
      contractsUrl
    });
  }
  const lines = [
    listingTitle ? `房源：${listingTitle}` : null,
    propertyLabel && propertyLabel !== listingTitle ? `租賃標的：${propertyLabel}` : null,
    tenantName ? `承租人：${tenantName}` : null,
    startDate && endDate ? `目前租期：${startDate} ～ ${endDate}` : (endDate ? `目前租約到期日：${endDate}` : null),
    rentAmount !== null && rentAmount !== undefined ? `每月租金：${money(rentAmount)}` : null,
    depositAmount !== null && depositAmount !== undefined ? `押金：${money(depositAmount)}` : null,
    dualRole
      ? '此帳號同時具備房客與房東身分，請選擇本次操作。'
      : '按下送出後，會通知房東回覆續約方案。'
  ].filter(Boolean);
  const buttons = dualRole
    ? [
        renewalAction({ label: '房客提出續約', displayText: '提出續約申請', action: 'renewal_start', extra: { lease: leasePublicId, role: 'tenant' } }),
        renewalAction({ label: '房東設定續約', displayText: '設定續約方案', action: 'renewal_start', extra: { lease: leasePublicId, role: 'landlord' } })
      ]
    : [renewalAction({
        label: '提出續約申請',
        action: 'renewal_start',
        extra: { lease: leasePublicId, ...(roles[0] ? { role: roles[0] } : {}) }
      })];
  if (contractsUrl) buttons.push(linkAction({ label: '查看目前合約', uri: contractsUrl }));
  const buttonColors = dualRole
    ? [TENANT_ACCENT, LANDLORD_ACCENT]
    : [roles[0] === 'landlord' ? LANDLORD_ACCENT : TENANT_ACCENT];
  return {
    type: 'flex',
    altText: '開始確認續約',
    contents: bubble({ title: '續約確認', lines, buttons, buttonColors })
  };
}

function renewalTenantPlanCard({
  leasePublicId, listingTitle, propertyLabel, startDate, endDate,
  rentAmount, depositAmount, contractsUrl
}) {
  const lines = [
    '請選擇你希望提出的續約方式。',
    listingTitle ? `房源：${listingTitle}` : null,
    propertyLabel && propertyLabel !== listingTitle ? `租賃標的：${propertyLabel}` : null,
    startDate && endDate ? `目前租期：${startDate} ～ ${endDate}` : null,
    rentAmount !== null && rentAmount !== undefined ? `每月租金：${money(rentAmount)}` : null,
    depositAmount !== null && depositAmount !== undefined ? `押金：${money(depositAmount)}` : null,
    { text: '送出後，房東可同意、提出其他條件或不續約。', small: true, color: MUTED_TEXT }
  ].filter(Boolean);
  const buttons = [
    renewalAction({
      label: '沿用原條件', action: 'renewal_tenant_plan',
      extra: { lease: leasePublicId, mode: 'reuse' }
    }),
    renewalAction({
      label: '提出修改條件', action: 'renewal_tenant_plan',
      extra: { lease: leasePublicId, mode: 'adjust' }
    })
  ];
  if (contractsUrl) buttons.push(linkAction({ label: '查看目前合約', uri: contractsUrl }));
  return {
    type: 'flex',
    altText: '選擇續約方式',
    contents: bubble({
      title: '提出續約意願',
      lines,
      buttons,
      titleColor: TENANT_ACCENT,
      backgroundColor: TENANT_BACKGROUND,
      buttonColors: [TENANT_ACCENT],
      buttonStyles: ['primary', 'secondary', 'secondary']
    })
  };
}

// Q1:房東願不願意續約。只有房東會看到這張卡。
function renewalQ1Card({
  renewalRequestPublicId, tenantName, propertyLabel, currentRentAmount,
  currentDepositAmount, currentStartDate, currentEndDate, contractsUrl
}) {
  const lines = [
    '承租人提出續約申請，請確認是否同意進入續約條件確認。',
    tenantName ? `承租人：${tenantName}` : null,
    propertyLabel ? `租賃標的：${propertyLabel}` : null,
    currentStartDate && currentEndDate ? `目前租期：${currentStartDate} ～ ${currentEndDate}` : null,
    currentRentAmount !== null && currentRentAmount !== undefined ? `每月租金：${money(currentRentAmount)}` : null,
    currentDepositAmount !== null && currentDepositAmount !== undefined ? `押金：${money(currentDepositAmount)}` : null
  ].filter(Boolean);
  const buttons = [
    renewalAction({ label: '同意續約', action: 'renewal_q1', extra: { id: renewalRequestPublicId, willing: '1' } }),
    renewalAction({ label: '不續約', action: 'renewal_decline_confirm', extra: { id: renewalRequestPublicId } })
  ];
  if (contractsUrl) buttons.push(linkAction({ label: '查看目前合約', uri: contractsUrl }));
  return {
    type: 'flex',
    altText: '收到續約申請，請確認是否同意續約',
    contents: bubble({
      title: '續約申請確認',
      lines,
      buttons,
      titleColor: LANDLORD_ACCENT,
      backgroundColor: LANDLORD_BACKGROUND,
      buttonColors: [LANDLORD_ACCENT]
    })
  };
}

function renewalDeclineConfirmationCard({ renewalRequestPublicId, propertyLabel, tenantName }) {
  return {
    type: 'flex',
    altText: '請確認是否不續約',
    contents: bubble({
      title: '確認不續約',
      lines: [
        tenantName ? `承租人：${tenantName}` : null,
        propertyLabel ? `租賃標的：${propertyLabel}` : null,
        '確認後將結束這筆續約申請，同一份現行租約不能再次提出續約。',
        { text: '若只是按錯，請返回上一頁。', small: true, color: MUTED_TEXT }
      ].filter(Boolean),
      buttons: [
        renewalAction({ label: '確認不續約', action: 'renewal_q1', extra: { id: renewalRequestPublicId, willing: '0' } }),
        renewalAction({ label: '返回', action: 'renewal_resume', extra: { id: renewalRequestPublicId } })
      ],
      titleColor: LANDLORD_ACCENT,
      backgroundColor: LANDLORD_BACKGROUND,
      buttonStyles: ['secondary', 'secondary']
    })
  };
}

// Q2:是否沿用目前條件。
function renewalQ2Card({
  renewalRequestPublicId, currentRentAmount, currentDepositAmount, currentStartDate, currentEndDate,
  unchangedTermsNegotiable = false, contractsUrl
}) {
  const lines = [
    '請確認是否沿用目前租約條件。',
    currentRentAmount !== null && currentRentAmount !== undefined ? `每月租金：${money(currentRentAmount)}` : null,
    currentStartDate && currentEndDate ? `目前租期：${currentStartDate} ～ ${currentEndDate}` : null,
    currentDepositAmount !== null && currentDepositAmount !== undefined ? `目前押金：${money(currentDepositAmount)}` : null,
    { text: unchangedTermsNegotiable
      ? '依你的續約規則，房客可針對原條件提出一次修改。'
      : '依你的續約規則，房客可接受或拒絕這份原條件方案。', small: true, color: MUTED_TEXT }
  ].filter(Boolean);
  const buttons = [
    renewalAction({ label: '沿用原條件', action: 'renewal_q2', extra: { id: renewalRequestPublicId, reusable: '1' } }),
    renewalAction({ label: '調整續約條件', action: 'renewal_q2', extra: { id: renewalRequestPublicId, reusable: '0' } })
  ];
  if (contractsUrl) buttons.push(linkAction({ label: '查看目前合約', uri: contractsUrl }));
  return {
    type: 'flex',
    altText: '續約方案設定',
    contents: bubble({
      title: '續約方案設定', lines, buttons,
      titleColor: LANDLORD_ACCENT,
      backgroundColor: LANDLORD_BACKGROUND,
      buttonColors: [LANDLORD_ACCENT]
    })
  };
}

function renewalCustomDraftCard({ sessionPublicId, propertyLabel, draft, actorRole = 'landlord' }) {
  const isTenant = actorRole === 'tenant';
  return {
    type: 'flex',
    altText: '確認調整後的續約條件',
    contents: bubble({
      title: isTenant ? '修改條件預覽' : '續約方案預覽',
      lines: [
        propertyLabel ? `租賃標的：${propertyLabel}` : null,
        `續約租期：${draft.startDate} ～ ${draft.endDate}`,
        `每月租金：${money(draft.rentAmount)}`,
        draft.depositAmount !== null && draft.depositAmount !== undefined
          ? `押金：${money(draft.depositAmount)}`
          : null,
        draft.dateInferenceNotice
          ? { text: draft.dateInferenceNotice, small: true, color: '#8A5A00' }
          : null,
        draft.note ? `調整說明：${draft.note}` : null,
        { text: isTenant
          ? '確認後會將這些條件送給房東決定。'
          : '此方案調整了原合約條件，房客可提出一次修改。', small: true, color: MUTED_TEXT }
      ].filter(Boolean),
      buttons: [
        renewalAction({
          label: isTenant ? '送出修改條件' : '送出續約方案',
          action: isTenant ? 'renewal_submit_tenant_changes' : 'renewal_submit_custom',
          extra: { session: sessionPublicId }
        }),
        renewalAction({
          label: '重新輸入',
          action: isTenant ? 'renewal_restart_tenant_changes' : 'renewal_restart_custom',
          extra: { session: sessionPublicId }
        }),
        renewalAction({
          label: '取消編輯',
          action: isTenant ? 'renewal_cancel_tenant_changes' : 'renewal_cancel_custom',
          extra: { session: sessionPublicId }
        })
      ],
      titleColor: isTenant ? TENANT_ACCENT : LANDLORD_ACCENT,
      backgroundColor: isTenant ? TENANT_BACKGROUND : LANDLORD_BACKGROUND,
      buttonColors: [isTenant ? TENANT_ACCENT : LANDLORD_ACCENT]
    })
  };
}

function renewalTenantCounterProposalCard({
  renewalRequestPublicId, proposal, reused = false, tenantName, propertyLabel
}) {
  return {
    type: 'flex',
    altText: '房客提出續約條件',
    contents: bubble({
      title: reused ? '房客提出原條件續約' : '房客提出修改條件',
      lines: [
        tenantName ? `承租人：${tenantName}` : null,
        propertyLabel ? `租賃標的：${propertyLabel}` : null,
        `租期：${proposal.startDate} ～ ${proposal.endDate}`,
        `租金：${money(proposal.rentAmount)}`,
        proposal.depositAmount !== null && proposal.depositAmount !== undefined
          ? `押金：${money(proposal.depositAmount)}`
          : null,
        { text: reused
          ? '房客希望沿用原合約條件，僅更新下一期租期。'
          : '房客提出了希望修改的續約條件。', small: true, color: MUTED_TEXT },
        { text: '請確認是否接受這份條件。', small: true, color: MUTED_TEXT }
      ].filter(Boolean),
      buttons: [
        renewalAction({ label: '同意房客條件', action: 'renewal_landlord_counter_decision', extra: { id: renewalRequestPublicId, decision: 'accept' } }),
        renewalAction({ label: '提出其他條件', action: 'renewal_landlord_counter_decision', extra: { id: renewalRequestPublicId, decision: 'revise' } }),
        renewalAction({ label: '不續約', action: 'renewal_landlord_counter_decline_confirm', extra: { id: renewalRequestPublicId } })
      ],
      titleColor: LANDLORD_ACCENT,
      backgroundColor: LANDLORD_BACKGROUND,
      buttonColors: [LANDLORD_ACCENT],
      buttonStyles: ['primary', 'secondary', 'secondary']
    })
  };
}

function renewalCounterDeclineConfirmationCard({ renewalRequestPublicId }) {
  return {
    type: 'flex',
    altText: '請確認是否不續約',
    contents: bubble({
      title: '確認不續約',
      lines: [
        '房客已提出希望修改的續約條件。',
        '確認後將結束這筆續約申請。',
        { text: '若只是按錯，請返回查看房客提出的條件。', small: true, color: MUTED_TEXT }
      ],
      buttons: [
        renewalAction({ label: '確認不續約', action: 'renewal_landlord_counter_decision', extra: { id: renewalRequestPublicId, decision: 'reject' } }),
        renewalAction({ label: '返回', action: 'renewal_resume', extra: { id: renewalRequestPublicId } })
      ],
      titleColor: LANDLORD_ACCENT,
      backgroundColor: LANDLORD_BACKGROUND,
      buttonStyles: ['secondary', 'secondary']
    })
  };
}

// 房客看到的續約提案卡——沿用條件自動產生的提案,或房東自行提出的新條件,都用這張卡。
function renewalProposalCard({ renewalRequestPublicId, proposal, reused, negotiable = true }) {
  const lines = [
    `租期：${proposal.startDate} ～ ${proposal.endDate}`,
    `租金：${money(proposal.rentAmount)}`,
    proposal.depositAmount !== null && proposal.depositAmount !== undefined
      ? `押金：${money(proposal.depositAmount)}`
      : null,
    { text: reused ? '房東選擇沿用目前租約的條件。' : '房東提出了新的續約條件。', small: true, color: MUTED_TEXT }
  ].filter(Boolean);
  return {
    type: 'flex',
    altText: '續約條件確認',
    contents: bubble({
      title: '續約提案確認',
      lines,
      titleColor: TENANT_ACCENT,
      backgroundColor: TENANT_BACKGROUND,
      buttonColors: [TENANT_ACCENT],
      buttons: [
        renewalAction({ label: '接受續約', action: 'renewal_decision', extra: { id: renewalRequestPublicId, decision: 'accept' } }),
        ...(negotiable
          ? [renewalAction({ label: '要求修改', action: 'renewal_decision', extra: { id: renewalRequestPublicId, decision: 'request_changes' } })]
          : []),
        renewalAction({ label: '拒絕續約', action: 'renewal_decision', extra: { id: renewalRequestPublicId, decision: 'reject' } })
      ]
    })
  };
}

// 續約提醒(系統在到期前 N 個月主動推)——按下去等同手動觸發續約的第一步。
function renewalReminderCard({ leasePublicId, listingTitle, endDate, monthsBefore, role = 'tenant' }) {
  return {
    type: 'flex',
    altText: '續約提醒',
    contents: bubble({
      title: '續約提醒',
      lines: [
        listingTitle ? listingTitle : null,
        `這份租約將於 ${endDate} 到期（尚餘約 ${monthsBefore} 個月）。`,
        '是否要開始處理續約？'
      ].filter(Boolean),
      buttons: [renewalAction({
        label: '查看續約選項', action: 'renewal_select_lease', extra: { lease: leasePublicId, role }
      })],
      titleColor: WARN_TEXT
    })
  };
}

const textMessage = (text) => ({ type: 'text', text });

module.exports = {
  ACCENT,
  LANDLORD_ACCENT,
  TENANT_ACCENT,
  WARN_BG,
  WARN_TEXT,
  money,
  noActiveLeaseMessage,
  renewalHomeCard,
  landlordRenewalMenuCard,
  renewalRulesCard,
  renewalLeaseSelectionCarousel,
  pendingRenewalCarousel,
  renewalLandlordDecisionCard,
  renewalStartCard,
  renewalTenantPlanCard,
  renewalQ1Card,
  renewalDeclineConfirmationCard,
  renewalQ2Card,
  renewalCustomDraftCard,
  renewalTenantCounterProposalCard,
  renewalCounterDeclineConfirmationCard,
  renewalProposalCard,
  renewalReminderCard,
  textMessage
};
