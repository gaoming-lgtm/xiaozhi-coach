// 装机教练的工具集。
// 原则：这里没有任何能跑命令、改文件的工具——装机的风险在手上，不在电脑上。
// 接线数据只能从 spec 读，模型不能自己编。

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'show_step',
      description:
        '把界面切到某一步：右侧 3D 会摆好这一步需要的零件、画出该接的线，学生眼前的步骤卡也会换成这一步。开始讲一步、或者学生说"我卡住了/下一步"时用。',
      parameters: {
        type: 'object',
        properties: {
          step: {
            type: 'string',
            description: '步骤编号，例如 "s06"；也可以写 next / prev / current',
          },
          reason: { type: 'string', description: '一句话说明为什么切到这一步' },
        },
        required: ['step'],
      },
    },
    meta: { risk: 'low', label: '切换步骤' },
  },
  {
    type: 'function',
    function: {
      name: 'show_3d',
      description:
        '只改 3D 画面，不换步骤。用来"指给他看"：高亮某个零件、单独画某几根线、把镜头推到某个视角。',
      parameters: {
        type: 'object',
        properties: {
          parts: {
            type: 'array',
            description: '要高亮的零件 id，例如 ["inmp441","esp32s3"]',
            items: { type: 'string' },
          },
          wires: {
            type: 'array',
            description: '只显示这些接线的 id；留空表示显示当前步骤的全部',
            items: { type: 'string' },
          },
          camera: {
            type: 'string',
            enum: ['iso', 'top', 'front', 'left', 'mic', 'amp', 'oled', 'power'],
            description: '镜头视角。mic / amp / oled 是推到对应模块的特写',
          },
          pulse: { type: 'string', description: '要闪烁强调的零件或接线 id' },
        },
      },
    },
    meta: { risk: 'low', label: '指给他看' },
  },
  {
    type: 'function',
    function: {
      name: 'get_wiring',
      description:
        '查官方接线表。这是唯一可信的接线来源——凡是要说"哪根线接到哪个脚"，必须先调这个，不许凭记忆说。',
      parameters: {
        type: 'object',
        properties: {
          module: {
            type: 'string',
            description: '按模块过滤：inmp441 / max98357 / oled / speaker；不填返回全部',
          },
          step: { type: 'string', description: '按步骤过滤，例如 "s07"' },
        },
      },
    },
    meta: { risk: 'low', label: '查接线表' },
  },
  {
    type: 'function',
    function: {
      name: 'record_check',
      description:
        '学生拍照片给你看之后，用这个记录这一步的验收结果。通过就推进进度，不通过就记下问题。',
      parameters: {
        type: 'object',
        properties: {
          step: { type: 'string', description: '步骤编号' },
          result: { type: 'string', enum: ['pass', 'fail', 'unsure'] },
          note: { type: 'string', description: '一句话说明看到了什么 / 哪里不对' },
          suspect: {
            type: 'array',
            description: '如果发现具体哪根线接错了，把接线 id 写进来（例如 ["w-mic-sd"]），3D 里会标红闪烁。不确定就留空。',
            items: { type: 'string' },
          },
        },
        required: ['step', 'result', 'note'],
      },
    },
    meta: { risk: 'low', label: '记录验收' },
  },
  {
    type: 'function',
    function: {
      name: 'show_checklist',
      description: '把零件清单铺到 3D 旁边，用来清点。第一步和"我是不是缺东西"时用。',
      parameters: { type: 'object', properties: {} },
    },
    meta: { risk: 'low', label: '铺开清单' },
  },
  {
    type: 'function',
    function: {
      name: 'get_troubleshoot',
      description:
        '查故障排查表。学生说"没声音 / 没反应 / 连不上 / 一直重启 / 听不见我说话"这类症状时，先查这个，照表里的顺序让他一条条检查，不要自己猜原因。',
      parameters: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: '症状关键词，例如 "没声音"、"没反应"、"COM 口"、"重启"、"听不见"；不填就返回全部症状清单',
          },
        },
      },
    },
    meta: { risk: 'low', label: '查故障表' },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.function.name, t]));
