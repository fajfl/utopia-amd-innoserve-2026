function postback(label, action, params = {}) {
  const data = new URLSearchParams({ action, ...params }).toString();
  return { type: 'postback', label, data, displayText: label };
}

function progressBar(ratio, color = '#00B900') {
  const percentage = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'md',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        width: `${percentage}%`,
        backgroundColor: color,
        height: '8px',
        cornerRadius: '4px',
        contents: [{ type: 'filler' }]
      },
      {
        type: 'box',
        layout: 'horizontal',
        width: `${100 - percentage}%`,
        backgroundColor: '#E0E0E0',
        height: '8px',
        cornerRadius: '4px',
        contents: [{ type: 'filler' }]
      }
    ]
  };
}

function statRow(label, value, valueColor = '#111111') {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#555555', flex: 1 },
      { type: 'text', text: String(value), size: 'sm', color: valueColor, weight: 'bold', align: 'end', flex: 1 }
    ]
  };
}

function reportMenuCard(summary) {
  if (!summary) {
    return {
      type: 'flex',
      altText: '報表分析',
      contents: {
        type: 'bubble',
        body: {
          type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '📊 報表分析', weight: 'bold', size: 'lg' },
            { type: 'text', text: '目前沒有報表資料', margin: 'md', color: '#888888' }
          ]
        }
      }
    };
  }

  const { unit_count, active_lease_count } = summary;
  const vacant_count = (unit_count || 0) - (active_lease_count || 0);

  return {
    type: 'flex',
    altText: '請選擇要查看的報表',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📊 報表分析', weight: 'bold', size: 'lg' },
          { type: 'text', text: '房東物件概覽', size: 'sm', color: '#888888', margin: 'sm' },
          {
            type: 'box', layout: 'horizontal', margin: 'md', contents: [
              {
                type: 'box', layout: 'vertical', flex: 1, alignItems: 'center', contents: [
                  { type: 'text', text: String(unit_count || 0), size: 'xl', weight: 'bold', color: '#111111' },
                  { type: 'text', text: '總單位數', size: 'xs', color: '#888888' }
                ]
              },
              {
                type: 'box', layout: 'vertical', flex: 1, alignItems: 'center', contents: [
                  { type: 'text', text: String(active_lease_count || 0), size: 'xl', weight: 'bold', color: '#00B900' },
                  { type: 'text', text: '出租中', size: 'xs', color: '#888888' }
                ]
              },
              {
                type: 'box', layout: 'vertical', flex: 1, alignItems: 'center', contents: [
                  { type: 'text', text: String(Math.max(0, vacant_count)), size: 'xl', weight: 'bold', color: '#FF334B' },
                  { type: 'text', text: '空置中', size: 'xs', color: '#888888' }
                ]
              }
            ]
          }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'button', style: 'primary', action: postback('💰 收益分析', 'report_revenue') },
          { type: 'button', style: 'secondary', action: postback('📈 出租趨勢', 'report_rental') },
          { type: 'button', style: 'secondary', action: postback('🏠 物件績效', 'report_property') }
        ]
      }
    }
  };
}

function revenueCard(data) {
  const { currentMonth, chargedAmount, paidAmount, outstandingAmount, collectionRate, chargeTypes } = data;
  
  const chargeTypeTranslations = {
    'rent': '租金',
    'management_fee': '管理費',
    'water': '水費',
    'electricity': '電費',
    'gas': '瓦斯費',
    'parking': '停車費',
    'repair': '修繕費',
    'other': '其他'
  };

  const chargeTypeBoxes = chargeTypes.map(ct => 
    statRow(`• ${chargeTypeTranslations[ct.charge_type] || ct.charge_type}`, `NT$ ${Number(ct.total_amount).toLocaleString()}`)
  );

  return {
    type: 'flex',
    altText: `${currentMonth} 收益分析`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: `💰 ${currentMonth} 收益分析`, weight: 'bold', size: 'lg' },
          { type: 'text', text: '本月應收總額', size: 'sm', color: '#888888', margin: 'md' },
          { type: 'text', text: `NT$ ${Number(chargedAmount).toLocaleString()}`, size: 'xxl', weight: 'bold', color: '#111111' },
          
          { type: 'separator', margin: 'md' },
          
          {
            type: 'box', layout: 'horizontal', margin: 'md', contents: [
              {
                type: 'box', layout: 'vertical', flex: 1, contents: [
                  { type: 'text', text: '已收金額', size: 'xs', color: '#888888' },
                  { type: 'text', text: `NT$ ${Number(paidAmount).toLocaleString()}`, size: 'md', weight: 'bold', color: '#00B900' }
                ]
              },
              {
                type: 'box', layout: 'vertical', flex: 1, contents: [
                  { type: 'text', text: '未收金額', size: 'xs', color: '#888888', align: 'end' },
                  { type: 'text', text: `NT$ ${Number(outstandingAmount).toLocaleString()}`, size: 'md', weight: 'bold', color: outstandingAmount > 0 ? '#FF334B' : '#111111', align: 'end' }
                ]
              }
            ]
          },
          
          {
            type: 'box', layout: 'horizontal', margin: 'sm', alignItems: 'center', contents: [
              { type: 'text', text: '收款率', size: 'xs', color: '#555555', flex: 1 },
              { type: 'text', text: `${collectionRate}%`, size: 'xs', weight: 'bold', color: '#111111', align: 'end' }
            ]
          },
          progressBar(collectionRate / 100, collectionRate >= 100 ? '#00B900' : (collectionRate >= 80 ? '#FFC107' : '#FF334B')),
          
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '費用分佈', size: 'sm', weight: 'bold', margin: 'md' },
          ...chargeTypeBoxes
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'button', style: 'primary', action: postback('查看近半年趨勢', 'report_revenue_trend') },
          { type: 'button', style: 'link', action: postback('返回報表選單', 'report_menu') }
        ]
      }
    }
  };
}

function revenueTrendCard(trendData) {
  const maxCharged = Math.max(...trendData.map(d => d.charged || 0), 1);
  
  const trendBoxes = trendData.map(d => {
    const ratio = (d.charged || 0) / maxCharged;
    const paidRatio = d.charged > 0 ? ((d.paid || 0) / d.charged) : 0;
    
    return {
      type: 'box', layout: 'vertical', margin: 'md', contents: [
        {
          type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: d.billing_month, size: 'xs', color: '#555555', flex: 2 },
            { type: 'text', text: `NT$ ${Number(d.paid || 0).toLocaleString()}`, size: 'xs', weight: 'bold', align: 'end', flex: 3 }
          ]
        },
        progressBar(paidRatio, paidRatio >= 1 ? '#00B900' : '#FFC107')
      ]
    };
  });

  return {
    type: 'flex',
    altText: '近半年收益趨勢',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📈 近半年收款趨勢', weight: 'bold', size: 'lg' },
          { type: 'separator', margin: 'md' },
          ...trendBoxes
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', contents: [
          { type: 'button', style: 'secondary', action: postback('返回', 'report_revenue') }
        ]
      }
    }
  };
}

function rentalTrendCard(data) {
  const { summary, funnel, vacantUnits } = data;
  
  const unitCount = summary?.unit_count || 0;
  const leasedCount = summary?.active_lease_count || 0;
  const occupancyRate = unitCount > 0 ? Math.round((leasedCount / unitCount) * 100) : 0;
  
  const vacantBoxes = vacantUnits.map(unit => ({
    type: 'box', layout: 'vertical', margin: 'sm', contents: [
      { type: 'text', text: `• ${unit.unit_label || unit.address_text || '未命名物件'}`, size: 'sm', weight: 'bold' },
      { type: 'text', text: `  預期租金 NT$ ${Number(unit.rent || 0).toLocaleString()}`, size: 'xs', color: '#888888' }
    ]
  }));

  if (vacantBoxes.length === 0) {
    vacantBoxes.push({ type: 'text', text: '目前無空置物件', size: 'sm', color: '#00B900', margin: 'sm' });
  }

  const funnelBoxes = [];
  if (funnel) {
    const inquiries = funnel.total_inquiries || 0;
    const intentions = funnel.total_intentions || 0;
    const contracts = funnel.total_contracts || 0;
    const leases = funnel.total_leases || 0;
    
    funnelBoxes.push(
      statRow('詢問', inquiries),
      statRow('意向', intentions),
      statRow('簽約', contracts),
      statRow('出租', leases)
    );
  } else {
    funnelBoxes.push({ type: 'text', text: '無漏斗數據', size: 'sm', color: '#888888' });
  }

  return {
    type: 'flex',
    altText: '出租趨勢',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📈 出租趨勢', weight: 'bold', size: 'lg' },
          
          { type: 'text', text: '總體出租率', size: 'sm', color: '#888888', margin: 'md' },
          {
            type: 'box', layout: 'horizontal', alignItems: 'flex-end', contents: [
              { type: 'text', text: `${occupancyRate}%`, size: 'xl', weight: 'bold', color: occupancyRate >= 80 ? '#00B900' : (occupancyRate >= 50 ? '#FFC107' : '#FF334B') },
              { type: 'text', text: ` (${leasedCount}/${unitCount})`, size: 'sm', color: '#888888', margin: 'sm' }
            ]
          },
          progressBar(occupancyRate / 100, occupancyRate >= 80 ? '#00B900' : (occupancyRate >= 50 ? '#FFC107' : '#FF334B')),
          
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '租客漏斗 (累計)', size: 'sm', weight: 'bold', margin: 'md' },
          ...funnelBoxes,
          
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '空置物件', size: 'sm', weight: 'bold', margin: 'md' },
          ...vacantBoxes
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', contents: [
          { type: 'button', style: 'secondary', action: postback('返回報表選單', 'report_menu') }
        ]
      }
    }
  };
}

function propertyPerformanceCarousel(properties) {
  if (!properties || properties.length === 0) {
    return {
      type: 'flex',
      altText: '物件績效',
      contents: {
        type: 'bubble',
        body: {
          type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '🏠 物件績效', weight: 'bold', size: 'lg' },
            { type: 'text', text: '無物件資料', margin: 'md', color: '#888888' }
          ]
        },
        footer: {
          type: 'box', layout: 'vertical', contents: [
            { type: 'button', style: 'secondary', action: postback('返回報表選單', 'report_menu') }
          ]
        }
      }
    };
  }

  const bubbles = properties.map(prop => {
    let attentionRow = [];
    if (prop.contractAttention && prop.contractAttention.attention_reason === 'lease_expiring') {
      attentionRow = [
        { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
          { type: 'text', text: '⚠️ 租約即將到期', size: 'xs', color: '#FFC107', weight: 'bold' }
        ]}
      ];
    } else if (prop.contractAttention && prop.contractAttention.attention_reason === 'pending_signature') {
      attentionRow = [
        { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
          { type: 'text', text: '⚠️ 等待簽署中', size: 'xs', color: '#FF334B', weight: 'bold' }
        ]}
      ];
    }

    const completionRate = prop.repair.ticket_count > 0 
      ? Math.round((prop.repair.completed_count / prop.repair.ticket_count) * 100) 
      : 100;

    return {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: prop.unit_label || prop.address_text || '未命名物件', weight: 'bold', size: 'md', wrap: true },
          { type: 'text', text: prop.unit_status === 'leased' ? '✅ 出租中' : '⚪ 空置/招租中', size: 'xs', color: prop.unit_status === 'leased' ? '#00B900' : '#888888', margin: 'sm' },
          
          { type: 'separator', margin: 'md' },
          
          statRow('月租金', `NT$ ${Number(prop.rent || 0).toLocaleString()}`),
          statRow('報修件數', `${prop.repair.ticket_count} 件`),
          statRow('報修完成率', `${completionRate}%`),
          statRow('平均處理(時)', prop.repair.average_completion_hours || 0),
          
          { type: 'separator', margin: 'md' },
          
          statRow('AI 知識', `${prop.knowledge.active_public_knowledge_count} 則`),
          ...attentionRow
        ]
      }
    };
  });
  
  // Add a final bubble to return to menu
  bubbles.push({
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', justifyContent: 'center', alignItems: 'center', contents: [
        { type: 'text', text: '返回報表選單', weight: 'bold', color: '#0066FF' }
      ],
      action: postback('返回報表選單', 'report_menu')
    }
  });

  return { type: 'flex', altText: '物件績效', contents: { type: 'carousel', contents: bubbles } };
}

module.exports = {
  reportMenuCard,
  revenueCard,
  revenueTrendCard,
  rentalTrendCard,
  propertyPerformanceCarousel
};