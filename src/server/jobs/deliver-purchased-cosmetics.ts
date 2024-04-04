import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';

export const deliverPurchasedCosmetics = createJob(
  'deliver-purchased-cosmetics',
  '*/1 * * * *',
  async () => {
    const [lastDelivered, setLastDelivered] = await getJobDate('last-cosmetic-delivery');

    const deliverPurchasedCosmetics = async () =>
      dbWrite.$executeRaw`
        -- Deliver purchased cosmetics
        with recent_purchases AS (
          SELECT
            u.id "userId",
            COALESCE(pdl.id, pd.id) "productId",
            p."createdAt"
          FROM "Purchase" p
          JOIN "Product" pd ON pd.id = p."productId"
          LEFT JOIN "Product" pdl
            ON pdl.active
              AND jsonb_typeof(pd.metadata->'level') != 'undefined'
              AND jsonb_typeof(pdl.metadata->'level') != 'undefined'
              AND (pdl.metadata->>'level')::int <= (pd.metadata->>'level')::int
          JOIN "User" u ON u."customerId" = p."customerId"
          WHERE p."createdAt" >= ${lastDelivered}
        )
        INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "obtainedAt")
        SELECT DISTINCT
          p."userId",
          c.id "cosmeticId",
          now()
        FROM recent_purchases p
        JOIN "Cosmetic" c ON
          c."productId" = p."productId"
          AND (c."availableStart" IS NULL OR p."createdAt" >= c."availableStart")
          AND (c."availableEnd" IS NULL OR p."createdAt" <= c."availableEnd")
        ON CONFLICT ("userId", "cosmeticId") DO NOTHING;
    `;

    const deliverSupporterUpgradeCosmetic = async () =>
      dbWrite.$executeRaw`
        -- Deliver supporter upgrade cosmetic
        INSERT INTO "UserCosmetic"("userId", "cosmeticId")
        SELECT
          cs."userId",
          c.id as "cosmeticId"
        FROM "CustomerSubscription" cs
        JOIN "Cosmetic" c ON c.name = 'Grandfather Badge'
        WHERE jsonb_typeof(metadata->'oldTier') != 'undefined'
          AND (metadata->>'upgradeMonth')::int = date_part('month', now())
          AND cs."updatedAt" > ${lastDelivered}
        ON CONFLICT DO NOTHING;
      `;

    const revokeMembershipLimitedCosmetics = async () =>
      dbWrite.$executeRaw`
        -- Revoke member limited cosmetics
        WITH to_revoke AS (
          SELECT
          "userId"
          FROM "CustomerSubscription" cs
          WHERE "cancelAt" <= ${lastDelivered}
        )
        DELETE FROM "UserCosmetic" uc
        WHERE EXISTS (
          SELECT 1
          FROM to_revoke r
          JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
          WHERE r."userId" = uc."userId"
          AND c."permanentUnlock" = false
          AND c.source = 'Membership'
        );
      `;

    // Deliver cosmetics
    // --------------------------------------------
    await deliverPurchasedCosmetics();
    await deliverSupporterUpgradeCosmetic();
    await revokeMembershipLimitedCosmetics();

    // Update the last time this ran in the KeyValue store
    // --------------------------------------------
    await setLastDelivered();
  }
);
