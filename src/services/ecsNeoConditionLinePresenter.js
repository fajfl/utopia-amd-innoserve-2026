// 承租條件整理結果的 LINE 呈現。純函式:只組訊息物件,不查資料庫、不推播。
//
// 卡片刻意把三件事分開講:
//   1. AI 整理出來的條件(每一項都附「依據」的來源種類)
//   2. 需要釐清的矛盾
//   3. 還缺的欄位
// 三者混在一起,房客會把 AI 的推測當成雙方已談定的條款。
//
// 「確認這個版本」帶的是**精確的 version public id**,不是「最新版」。
// 卡片是舊的、後來又整理過的話,伺服器端會回 stale 並要求重看,而不是把
// 房客的手指按在他沒看過的條件上。

const { liffUrl } = require('./liffSessionService');

const COLORS = {
  brand: '#0F766E',
  brandSoft: '#A7E5D7',
  title: '#111827',
  muted: '#64748B',
  line: '#E5E7EB',
  warn: '#B45309',
  warnBg: '#FFFBEB',
  danger: '#B91C1C',
  dangerBg: '#FEF2F2'
};

const SOURCE_TYPE_LABELS = {
  message: '對話紀錄',
  listing_snapshot: '房源資料',
  knowledge_version: '房東知識庫',
  manual_input: '人工輸入'
};

function sourceLabel(sources = []) {
  const kinds = [...new Set(sources.map((source) => SOURCE_TYPE_LABELS[source.sourceType] || source.sourceType))];
  if (kinds.length === 0) return '無依據';
  return `依據：${kinds.join('、')}`;
}

function truncate(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function fieldRow(field) {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'none',
    margin: 'md',
    contents: [
      {
        type: 'box',
        layout: 'baseline',
        contents: [
          { type: 'text', text: field.label, size: 'sm', color: COLORS.muted, flex: 4, wrap: true },
          { type: 'text', text: field.path === 'specialRequest' ? field.display : truncate(field.display, 40), size: 'sm', weight: 'bold', color: COLORS.title, flex: 5, wrap: true }
        ]
      },
      { type: 'text', text: sourceLabel(field.sources), size: 'xxs', color: COLORS.muted, margin: 'xs' }
    ]
  };
}

function noticeBlock({ title, items, color, backgroundColor }) {
  return {
    type: 'box',
    layout: 'vertical',
    margin: 'lg',
    paddingAll: 'md',
    cornerRadius: 'md',
    backgroundColor,
    spacing: 'xs',
    contents: [
      { type: 'text', text: title, size: 'xs', weight: 'bold', color },
      ...items.slice(0, 5).map((item) => ({
        type: 'text', text: `• ${truncate(item, 90)}`, size: 'xs', color, wrap: true
      })),
      ...(items.length > 5
        ? [{ type: 'text', text: `…另有 ${items.length - 5} 項`, size: 'xxs', color }]
        : [])
    ]
  };
}

/**
 * 條件整理結果卡片。
 *
 * @param {object} input
 * @param {string} input.versionPublicId 精確版本 public id(確認時原樣回傳)
 */
function conditionSummaryCard({
  versionPublicId,
  versionNumber,
  listingTitle,
  fields = [],
  conflicts = [],
  missingFields = [],
  unsourcedFields = [],
  confirmed = false
}) {
  const body = [
    {
      type: 'text',
      text: truncate(listingTitle || '目前房源', 40),
      weight: 'bold',
      size: 'md',
      color: COLORS.title,
      wrap: true
    },
    {
      type: 'text',
      text: 'AI 候選整理結果，尚未成為契約條款',
      size: 'xxs',
      color: COLORS.muted,
      margin: 'xs',
      wrap: true
    },
    { type: 'separator', margin: 'lg', color: COLORS.line }
  ];

  if (fields.length === 0) {
    body.push({
      type: 'text',
      text: '目前的對話還沒有可以追溯到原文的條件。請直接在聊天室說明你談定的租金、租期、押金等條件，再輸入「條件整理」。',
      size: 'sm',
      color: COLORS.title,
      margin: 'lg',
      wrap: true
    });
  } else {
    body.push(...fields.slice(0, 12).map(fieldRow));
    if (fields.length > 12) {
      body.push({ type: 'text', text: `…另有 ${fields.length - 12} 項條件`, size: 'xxs', color: COLORS.muted, margin: 'md' });
    }
  }

  if (conflicts.length > 0) {
    body.push(noticeBlock({
      title: '需要你釐清的矛盾',
      items: conflicts,
      color: COLORS.danger,
      backgroundColor: COLORS.dangerBg
    }));
  }
  if (unsourcedFields.length > 0) {
    body.push(noticeBlock({
      title: '找不到依據，已移除',
      items: unsourcedFields.map((field) => `${field.label}（原文沒有明確說明）`),
      color: COLORS.warn,
      backgroundColor: COLORS.warnBg
    }));
  }
  if (missingFields.length > 0) {
    body.push(noticeBlock({
      title: '還缺這些條件',
      items: missingFields,
      color: COLORS.warn,
      backgroundColor: COLORS.warnBg
    }));
  }

  // 這張卡的數字是程式從版本紀錄產生的;聊天回覆是模型寫的,可能被房客的話帶偏。
  body.push({
    type: 'text',
    text: '金額、日期與條款以這張卡片為準，聊天回覆只是說明。',
    size: 'xxs',
    color: COLORS.muted,
    wrap: true,
    margin: 'lg'
  });

  const footerButtons = [
    {
      type: 'button',
      style: 'primary',
      height: 'sm',
      color: COLORS.brand,
      action: {
        type: 'postback',
        label: confirmed ? '已確認這個版本' : '確認這個版本',
        data: `action=ecs_condition_confirm&version=${encodeURIComponent(versionPublicId)}`,
        displayText: `我確認第 ${versionNumber} 版承租條件`
      }
    },
    {
      type: 'button',
      style: 'secondary',
      height: 'sm',
      action: {
        type: 'postback',
        label: '查看逐項依據',
        data: `action=ecs_condition_sources&version=${encodeURIComponent(versionPublicId)}`,
        displayText: `查看第 ${versionNumber} 版的依據`
      }
    },
    {
      type: 'button',
      style: 'link',
      height: 'sm',
      action: {
        type: 'postback',
        label: '這裡不對／要補條件',
        data: `action=ecs_condition_revise&version=${encodeURIComponent(versionPublicId)}`,
        displayText: '我要修改承租條件'
      }
    }
  ];

  return {
    type: 'flex',
    altText: `承租條件整理（第 ${versionNumber} 版）`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: COLORS.brand,
        paddingAll: 'xl',
        contents: [
          { type: 'text', text: '承租條件整理', weight: 'bold', size: 'xl', color: '#FFFFFF' },
          {
            type: 'text',
            text: confirmed ? `第 ${versionNumber} 版｜你已確認` : `第 ${versionNumber} 版｜待你確認`,
            size: 'xs',
            color: COLORS.brandSoft,
            margin: 'sm'
          }
        ]
      },
      body: { type: 'box', layout: 'vertical', paddingAll: 'xl', contents: body },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'lg', contents: footerButtons }
    }
  };
}

/**
 * 逐項依據的文字版。這裡會引用原始訊息,所以只能回給該筆詢問的房客本人。
 */
function conditionSourcesMessage({ versionNumber, fields = [], sources = [] }) {
  const byPath = new Map();
  for (const source of sources) {
    if (!byPath.has(source.field_path)) byPath.set(source.field_path, []);
    byPath.get(source.field_path).push(source);
  }

  const lines = [`第 ${versionNumber} 版承租條件的逐項依據：`, ''];
  if (fields.length === 0) {
    lines.push('這個版本沒有可追溯的條件欄位。');
  }
  for (const field of fields) {
    lines.push(`■ ${field.label}：${field.display}`);
    const rows = byPath.get(field.path) || [];
    if (rows.length === 0) {
      lines.push('  （查無來源紀錄）');
      continue;
    }
    for (const row of rows) {
      const kind = SOURCE_TYPE_LABELS[row.source_type] || row.source_type;
      const quote = row.text_content ? `「${truncate(row.text_content, 60)}」` : '';
      lines.push(`  · ${kind}${quote}`);
    }
  }
  lines.push('', '以上是 AI 依原文整理的候選條件，還不是契約條款。');
  return { type: 'text', text: lines.join('\n') };
}

function reviseGuidanceMessage({ versionNumber }) {
  return {
    type: 'text',
    text: [
      `要修正第 ${versionNumber} 版的話，請直接在這個聊天室打出正確的內容，例如：`,
      '「押金是兩個月」、「租期從民國115年7月1日到116年6月30日」、「租金談到 17000」。',
      '',
      '補完之後輸入「條件整理」，我會重新整理成新的一版；舊版本會原樣保留，不會被改掉。'
    ].join('\n')
  };
}

function confirmedMessage({ versionNumber, listingTitle }) {
  return {
    type: 'text',
    text: [
      `已記錄：你確認的是「${truncate(listingTitle || '目前房源', 30)}」承租條件第 ${versionNumber} 版。`,
      '這一版從現在起不會再變動。',
      '',
      '接下來由房東就這一版決定接受、要求修改或拒絕。房東接受後，系統會通知你去查看合約草稿。'
    ].join('\n')
  };
}

function replayedConfirmMessage({ versionNumber }) {
  return { type: 'text', text: `第 ${versionNumber} 版你已經確認過了，不會重複送出。` };
}

function staleVersionMessage({ latestVersionNumber }) {
  const suffix = latestVersionNumber
    ? `目前最新的是第 ${latestVersionNumber} 版。`
    : '條件剛剛又被整理過。';
  return {
    type: 'text',
    text: `這張卡片上的版本已經不是最新的，${suffix}\n請輸入「條件整理」重新查看後再確認。`
  };
}

/**
 * 房東接受、下游草稿產生之後,提醒房客去看合約草稿。
 * 卡片只導頁,不放「簽署」:發行與簽署要在合約頁由人明確操作。
 */
function contractDraftReadyMessage({ listingTitle, versionNumber } = {}) {
  const detail = versionNumber
    ? `依你確認的承租條件第 ${versionNumber} 版產生。`
    : '依你確認的承租條件版本產生。';
  return {
    type: 'template',
    altText: '租約草稿已產生，請查看',
    template: {
      type: 'buttons',
      title: '租約草稿已產生',
      text: truncate(`「${listingTitle || '你的房源'}」${detail}請開啟查看全文與逐條依據。`, 60),
      actions: [
        { type: 'uri', label: '查看合約草稿', uri: liffUrl('/v2/contracts/drafts') }
      ]
    }
  };
}

module.exports = {
  SOURCE_TYPE_LABELS,
  conditionSourcesMessage,
  conditionSummaryCard,
  confirmedMessage,
  contractDraftReadyMessage,
  replayedConfirmMessage,
  reviseGuidanceMessage,
  staleVersionMessage
};
