const { contractsUrl } = require('./cardMessageService');

const COLORS = {
  navy: '#082967', blue: '#1478F2', pale: '#EAF4FF', muted: '#63718D', line: '#DDE8F4', white: '#FFFFFF'
};

function statusCardMessage(contract) {
  if (!contract) return null;
  const stageLabels = ['協調', '草稿', '房客簽', '房東簽'];
  const stages = stageLabels.map((label, index) => {
    const done = contract.stage >= 4 || index < contract.stage;
    const active = index === contract.stage && contract.stage < 4;
    return {
      type: 'box', layout: 'vertical', flex: 1, alignItems: 'center', contents: [
        {
          type: 'box', layout: 'vertical', width: '28px', height: '28px', cornerRadius: '14px',
          backgroundColor: done || active ? COLORS.blue : '#E5EBF2', justifyContent: 'center', alignItems: 'center',
          contents: [{ type: 'text', text: done ? '✓' : String(index + 1), size: 'xs', weight: 'bold', color: done || active ? COLORS.white : '#8190A8', align: 'center' }]
        },
        { type: 'text', text: label, size: 'xxs', color: active ? COLORS.blue : COLORS.muted, weight: active ? 'bold' : 'regular', margin: 'sm', align: 'center' }
      ]
    };
  });
  const actions = [];
  if (contract.action) actions.push({
    type: 'button', style: 'primary', color: COLORS.blue, height: 'sm',
    action: { type: 'uri', label: contract.action.label.slice(0, 20), uri: contractsUrl() }
  });
  // 兩顆按鈕都連合約中心,有主按鈕時第二顆只是重複。
  if (!contract.action) actions.push({
    type: 'button', style: 'secondary', height: 'sm',
    action: { type: 'uri', label: '開啟我的合約', uri: contractsUrl() }
  });
  return {
    type: 'flex', altText: `合約進度：${contract.headline}`,
    contents: {
      type: 'bubble', size: 'mega',
      header: { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: COLORS.navy, contents: [
        { type: 'text', text: '我的合約進度', size: 'sm', color: '#BFD8FF', weight: 'bold' },
        { type: 'text', text: contract.title, size: 'xl', color: COLORS.white, weight: 'bold', wrap: true, margin: 'sm' }
      ] },
      body: { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: COLORS.white, contents: [
        { type: 'text', text: contract.statusLabel, size: 'xs', color: COLORS.blue, weight: 'bold' },
        { type: 'text', text: contract.headline, size: 'lg', color: COLORS.navy, weight: 'bold', wrap: true, margin: 'sm' },
        { type: 'text', text: contract.detail, size: 'sm', color: COLORS.muted, wrap: true, margin: 'sm' },
        { type: 'separator', color: COLORS.line, margin: 'xl' },
        { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'xl', contents: stages }
      ] },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', backgroundColor: COLORS.white, contents: actions }
    }
  };
}

module.exports = { statusCardMessage };
