/** Package entry: the default export is the WorldDefinition. */
import type { WorldDefinition, WorldDescribe } from 'cortico/world.ts';
import { ASTRBOT_DEFAULTS, ASTRBOT_ID, EVENT_PROACTIVE, type AstrbotSection } from './config.ts';
import { createAstrbotWorld } from './world.ts';

const DESCRIBE: WorldDescribe = {
  tools: [
    {
      name: 'astrbot_recall',
      tags: ['read'],
      description:
        'Search what AstrBot remembers about the person: preferences, habits, things they said they like or dislike, and past context.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for, in the person\'s own words.' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
      },
      summary: { zh: '检索 AstrBot 记下的这个人的喜好、习惯与过往。', en: 'Searches what AstrBot remembers about the person.' },
    },
  ],
  events: [
    {
      type: EVENT_PROACTIVE,
      // 声明上的 trigger 只是默认提示；实际送达方式由 worlds.astrbot.wakeMode 决定
      trigger: 'flush',
      tags: ['speak'],
      description: {
        zh: 'AstrBot 给这个人发的主动消息，桌宠把它说成气泡。',
        en: 'A line AstrBot sent to the person on its own; the pet says it in a bubble.',
      },
    },
  ],
};

export const ASTRBOT: WorldDefinition<AstrbotSection> = {
  id: ASTRBOT_ID,
  label: 'AstrBot',
  defaults: () => structuredClone(ASTRBOT_DEFAULTS),
  create: (ctx) => createAstrbotWorld(ctx),
  describe: DESCRIBE,
};

export default ASTRBOT;
