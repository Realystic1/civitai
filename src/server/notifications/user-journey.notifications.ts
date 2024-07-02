import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const userJourneyNotifications = createNotificationProcessor({
  // Moveable
  'join-community': {
    displayName: 'Welcome to Civitai',
    category: 'System',
    toggleable: false,
    prepareMessage: () => ({
      message: `Happy to have you here! Come join our Discord server to stay up to date with the community and updates to the platform.`,
      url: `/discord`,
      target: '_blank',
    }),
    prepareQuery: ({ lastSent }) => `
      SELECT
        CONCAT('join-community:',"id"),
        id "userId",
        'join-community' "type",
        '{}'::jsonb "details"
      FROM "User"
      WHERE "createdAt" > '${lastSent}'
    `,
  },
});
