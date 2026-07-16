import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { dealRoundFromShoe } from "./baccarat.js";
import { verifyShoeAudit } from "./shoe-audit.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function databaseUrlForSchema(databaseUrl: string, schema: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

test("persists active secrets across restart and immutable proof after rotation", { skip: !testDatabaseUrl }, async () => {
  const schema = `shoe_audit_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: testDatabaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);

  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "shoe-audit-integration-test-secret";
  process.env.DATABASE_URL = databaseUrlForSchema(testDatabaseUrl!, schema);

  const db = await import("./db.js");
  const passwordHash = `$2b$12$${"a".repeat(53)}`;
  const fundingActorId = randomUUID();

  try {
    await db.initializeDatabase();
    const tableId = randomUUID();
    await db.pool.query(
      `INSERT INTO game_tables (id, code, name, display_order, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [tableId, `T-${tableId}`, "Audit table", 1, new Date().toISOString()],
    );

    const firstShoe = await db.replaceTableShoe(tableId);
    const activeAudit = await db.getShoeAuditBundle(firstShoe.shoeId);
    assert.ok(activeAudit);
    assert.equal(activeAudit.reveal, null);
    assert.equal(JSON.stringify(activeAudit).includes("seed"), false);

    const secretBeforeRestart = await db.pool.query(
      "SELECT seed_hex FROM shoe_secrets WHERE shoe_id = $1",
      [firstShoe.shoeId],
    );
    const activeSeed = String(secretBeforeRestart.rows[0]?.seed_hex);
    assert.match(activeSeed, /^[0-9a-f]{64}$/);
    const publicTableState = await db.buildTablePublicState(tableId);
    assert.equal(publicTableState?.shoeAudit?.commitment, activeAudit.commitment);
    assert.equal(JSON.stringify(publicTableState).includes(activeSeed), false);

    await assert.rejects(
      db.withTransaction(async (client) => {
        const workingShoe = await db.getTableShoe(tableId, client, { forUpdate: true });
        assert.ok(workingShoe);
        const before = [...workingShoe.cards];
        const result = dealRoundFromShoe(workingShoe);
        await db.recordShoeDealAudit(
          {
            shoeId: workingShoe.shoeId,
            roundId: randomUUID(),
            dealtCards: before.slice().reverse().slice(0, before.length - workingShoe.cards.length),
            result: {
              playerCards: result.playerCards,
              bankerCards: result.bankerCards,
              playerTotal: result.playerTotal,
              bankerTotal: result.bankerTotal,
              winner: result.winner,
              playerPair: result.playerPair,
              bankerPair: result.bankerPair,
            },
          },
          client,
        );
        await db.saveTableShoe(tableId, workingShoe.shoeId, workingShoe, client);
        throw new Error("simulated worker crash");
      }),
      /simulated worker crash/,
    );
    assert.equal((await db.getTableShoe(tableId))?.cards.length, firstShoe.cards.length);
    assert.equal((await db.getShoeAuditBundle(firstShoe.shoeId))?.deals.length, 0);

    const committedShoe = await db.withTransaction(async (client) => {
      const workingShoe = await db.getTableShoe(tableId, client, { forUpdate: true });
      assert.ok(workingShoe);
      const before = [...workingShoe.cards];
      const result = dealRoundFromShoe(workingShoe);
      await db.recordShoeDealAudit(
        {
          shoeId: workingShoe.shoeId,
          roundId: randomUUID(),
          dealtCards: before.slice().reverse().slice(0, before.length - workingShoe.cards.length),
          result: {
            playerCards: result.playerCards,
            bankerCards: result.bankerCards,
            playerTotal: result.playerTotal,
            bankerTotal: result.bankerTotal,
            winner: result.winner,
            playerPair: result.playerPair,
            bankerPair: result.bankerPair,
          },
        },
        client,
      );
      await db.saveTableShoe(tableId, workingShoe.shoeId, workingShoe, client);
      return workingShoe;
    });

    const reloadedShoe = await db.getTableShoe(tableId);
    assert.deepEqual(reloadedShoe?.cards, committedShoe.cards);
    assert.equal((await db.getShoeCommitment(firstShoe.shoeId))?.commitment, activeAudit.commitment);

    const nextShoe = await db.withTransaction(async (client) => {
      const workingShoe = await db.getTableShoe(tableId, client, { forUpdate: true });
      assert.ok(workingShoe);

      for (;;) {
        const wasLastHand = workingShoe.lastHandPending;
        const before = [...workingShoe.cards];
        const result = dealRoundFromShoe(workingShoe);
        await db.recordShoeDealAudit(
          {
            shoeId: workingShoe.shoeId,
            roundId: randomUUID(),
            dealtCards: before.slice().reverse().slice(0, before.length - workingShoe.cards.length),
            result: {
              playerCards: result.playerCards,
              bankerCards: result.bankerCards,
              playerTotal: result.playerTotal,
              bankerTotal: result.bankerTotal,
              winner: result.winner,
              playerPair: result.playerPair,
              bankerPair: result.bankerPair,
            },
          },
          client,
        );

        if (wasLastHand) {
          await db.saveTableShoe(tableId, workingShoe.shoeId, workingShoe, client);
          return db.replaceTableShoe(tableId, client, "CUT_CARD_LAST_HAND");
        }
        if (result.cutCardAppeared) workingShoe.lastHandPending = true;
      }
    });
    assert.notEqual(nextShoe.shoeId, firstShoe.shoeId);

    const revealedAudit = await db.getShoeAuditBundle(firstShoe.shoeId);
    assert.ok(revealedAudit?.reveal);
    assert.equal(revealedAudit.reveal.reason, "CUT_CARD_LAST_HAND");
    assert.equal(verifyShoeAudit(revealedAudit).valid, true);
    assert.equal(
      Number((await db.pool.query("SELECT COUNT(*) AS count FROM shoe_secrets WHERE shoe_id = $1", [firstShoe.shoeId])).rows[0].count),
      0,
    );
    assert.equal((await db.getShoeAuditBundle(nextShoe.shoeId))?.reveal, null);

    await assert.rejects(
      db.pool.query("UPDATE shoe_commitments SET commitment = commitment WHERE shoe_id = $1", [firstShoe.shoeId]),
      /append-only/,
    );
    await assert.rejects(
      db.pool.query("DELETE FROM shoe_deal_audits WHERE shoe_id = $1", [firstShoe.shoeId]),
      /append-only/,
    );
    await assert.rejects(
      db.pool.query("DELETE FROM shoe_reveals WHERE shoe_id = $1", [firstShoe.shoeId]),
      /append-only/,
    );
    await assert.rejects(db.pool.query("TRUNCATE shoe_deal_audits"), /append-only/);
    await assert.rejects(
      db.pool.query("UPDATE shoe_secrets SET seed_hex = seed_hex WHERE shoe_id = $1", [nextShoe.shoeId]),
      /append-only/,
    );
    await assert.rejects(
      db.pool.query(
        `INSERT INTO shoe_deal_audits (round_id, shoe_id, deal_index, dealt_cards, round_result, recorded_at)
         VALUES ($1, $2, $3, '[]'::jsonb, '{}'::jsonb, $4)`,
        [randomUUID(), firstShoe.shoeId, 99, new Date().toISOString()],
      ),
      /after shoe reveal/,
    );

    const { settleActiveRound } = await import("./round-manager.js");
    const settlementTableId = randomUUID();
    await db.pool.query(
      `INSERT INTO game_tables (id, code, name, display_order, created_at)
       VALUES ($1, $2, 'Settlement guard table', 10, $3)`,
      [settlementTableId, `S-${settlementTableId}`, new Date().toISOString()],
    );
    const settlementShoe = await db.replaceTableShoe(settlementTableId);
    const mismatchPlayer = await db.createPlayer({
      username: `mismatch_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
      passwordHash,
      balance: 1_000,
      actorId: fundingActorId,
    });
    const mismatchRound = await db.createRound({
      tableId: settlementTableId,
      shoeId: "not-the-locked-table-shoe",
      status: "LOCKED",
      bettingOpensAt: new Date(Date.now() - 2_000).toISOString(),
      bettingClosesAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await db.withTransaction(async (client) => {
      const bet = await db.createBet(
        { userId: mismatchPlayer.id, roundId: mismatchRound.id, betType: "PLAYER", amount: 100 },
        client,
      );
      await db.applyBalanceMutation(
        {
          userId: mismatchPlayer.id,
          delta: -100,
          actorType: "PLAYER",
          actorId: mismatchPlayer.id,
          source: "BET_DEBIT",
          referenceType: "BET",
          referenceId: bet.id,
        },
        client,
      );
    });

    await settleActiveRound(mismatchRound.id, settlementTableId);
    assert.equal((await db.findRoundById(mismatchRound.id))?.status, "CANCELLED");
    assert.equal((await db.findRoundById(mismatchRound.id))?.cancellationReason, "SHOE_BINDING_INVALID");
    assert.equal((await db.findUserById(mismatchPlayer.id))?.balance, 1_000);
    assert.equal((await db.listRoundBets(mismatchRound.id))[0]?.payout, 100);
    assert.equal((await db.getTableShoe(settlementTableId))?.shoeId, settlementShoe.shoeId);
    assert.equal((await db.getShoeAuditBundle(settlementShoe.shoeId))?.deals.length, 0);

    const insufficientState = {
      ...settlementShoe,
      cards: settlementShoe.cards.slice(0, 5),
    };
    await db.saveTableShoe(settlementTableId, settlementShoe.shoeId, insufficientState);
    const insufficientPlayer = await db.createPlayer({
      username: `insufficient_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      passwordHash,
      balance: 1_000,
      actorId: fundingActorId,
    });
    const insufficientRound = await db.createRound({
      tableId: settlementTableId,
      shoeId: settlementShoe.shoeId,
      status: "LOCKED",
      bettingOpensAt: new Date(Date.now() - 2_000).toISOString(),
      bettingClosesAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await db.withTransaction(async (client) => {
      const bet = await db.createBet(
        { userId: insufficientPlayer.id, roundId: insufficientRound.id, betType: "BANKER", amount: 200 },
        client,
      );
      await db.applyBalanceMutation(
        {
          userId: insufficientPlayer.id,
          delta: -200,
          actorType: "PLAYER",
          actorId: insufficientPlayer.id,
          source: "BET_DEBIT",
          referenceType: "BET",
          referenceId: bet.id,
        },
        client,
      );
    });

    await settleActiveRound(insufficientRound.id, settlementTableId);
    assert.equal((await db.findRoundById(insufficientRound.id))?.status, "CANCELLED");
    assert.equal(
      (await db.findRoundById(insufficientRound.id))?.cancellationReason,
      "INSUFFICIENT_COMMITTED_CARDS",
    );
    assert.equal((await db.findUserById(insufficientPlayer.id))?.balance, 1_000);
    assert.equal((await db.getTableShoe(settlementTableId))?.shoeId, settlementShoe.shoeId);
    assert.equal((await db.getTableShoe(settlementTableId))?.cards.length, 5);
    const replacementAfterCancellation = await db.ensureTableShoe(settlementTableId);
    assert.notEqual(replacementAfterCancellation.shoeId, settlementShoe.shoeId);
    assert.ok(await db.getShoeCommitment(replacementAfterCancellation.shoeId));

    const legacyTableId = randomUUID();
    await db.pool.query(
      `INSERT INTO game_tables (id, code, name, display_order, current_shoe_id, shoe_state, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        legacyTableId,
        `L-${legacyTableId}`,
        "Legacy table",
        50,
        "legacy-shoe",
        JSON.stringify([{ suit: "S", rank: "A" }]),
        new Date().toISOString(),
      ],
    );
    const legacyPlayer = await db.createPlayer({
      username: `legacy_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
      passwordHash,
      balance: 1_000,
      actorId: fundingActorId,
    });
    const legacyRound = await db.createRound({
      tableId: legacyTableId,
      shoeId: "legacy-shoe",
      status: "OPEN",
      bettingOpensAt: new Date(Date.now() - 1_000).toISOString(),
      bettingClosesAt: new Date(Date.now() + 30_000).toISOString(),
    });
    await db.withTransaction(async (client) => {
      const bet = await db.createBet(
        { userId: legacyPlayer.id, roundId: legacyRound.id, betType: "TIE", amount: 300 },
        client,
      );
      await db.applyBalanceMutation(
        {
          userId: legacyPlayer.id,
          delta: -300,
          actorType: "PLAYER",
          actorId: legacyPlayer.id,
          source: "BET_DEBIT",
          referenceType: "BET",
          referenceId: bet.id,
        },
        client,
      );
    });

    await db.ensureSeedData({ seedDemoUsers: false });
    const migrated = await db.getTableShoe(legacyTableId);
    assert.ok(migrated);
    assert.notEqual(migrated.shoeId, "legacy-shoe");
    assert.ok(await db.getShoeCommitment(migrated.shoeId));
    assert.equal(await db.getShoeAuditBundle("legacy-shoe"), null);
    const cancelledLegacyRound = await db.findRoundById(legacyRound.id);
    assert.equal(cancelledLegacyRound?.status, "CANCELLED");
    assert.equal(cancelledLegacyRound?.cancellationReason, "LEGACY_SHOE_UNAUDITED");
    assert.equal(cancelledLegacyRound?.shoeId, "legacy-shoe");
    assert.equal((await db.findUserById(legacyPlayer.id))?.balance, 1_000);

    const concurrentTableIds = [randomUUID(), randomUUID()];
    await db.pool.query(
      `INSERT INTO game_tables (id, code, name, display_order, created_at)
       VALUES ($1, $2, 'Concurrent A', 20, $3), ($4, $5, 'Concurrent B', 21, $3)`,
      [
        concurrentTableIds[0],
        `C-${concurrentTableIds[0]}`,
        new Date().toISOString(),
        concurrentTableIds[1],
        `C-${concurrentTableIds[1]}`,
      ],
    );
    const concurrentShoes = await Promise.all(concurrentTableIds.map((id) => db.replaceTableShoe(id)));
    assert.notEqual(concurrentShoes[0].shoeId, concurrentShoes[1].shoeId);
    assert.notEqual(
      (await db.getShoeCommitment(concurrentShoes[0].shoeId))?.commitment,
      (await db.getShoeCommitment(concurrentShoes[1].shoeId))?.commitment,
    );

    const raceTableId = randomUUID();
    await db.pool.query(
      `INSERT INTO game_tables (id, code, name, display_order, created_at)
       VALUES ($1, $2, 'Lifecycle race table', 30, $3)`,
      [raceTableId, `R-${raceTableId}`, new Date().toISOString()],
    );
    const raceShoe = await db.replaceTableShoe(raceTableId);
    const revealClient = await db.pool.connect();
    const dealClient = await db.pool.connect();
    try {
      await revealClient.query("BEGIN");
      await dealClient.query("BEGIN");
      await db.replaceTableShoe(raceTableId, revealClient, "CONCURRENT_ROTATION");
      const blockedDeal = db.recordShoeDealAudit(
        {
          shoeId: raceShoe.shoeId,
          roundId: randomUUID(),
          dealtCards: [],
          result: {
            playerCards: [],
            bankerCards: [],
            playerTotal: 0,
            bankerTotal: 0,
            winner: "TIE",
            playerPair: false,
            bankerPair: false,
          },
        },
        dealClient,
      );
      const raceState = await Promise.race([
        blockedDeal.then(() => "settled", () => "settled"),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 25)),
      ]);
      assert.equal(raceState, "blocked");
      await revealClient.query("COMMIT");
      await assert.rejects(blockedDeal, /after shoe reveal/);
      await dealClient.query("ROLLBACK");
    } finally {
      await revealClient.query("ROLLBACK").catch(() => undefined);
      await dealClient.query("ROLLBACK").catch(() => undefined);
      revealClient.release();
      dealClient.release();
    }
    assert.equal((await db.getShoeAuditBundle(raceShoe.shoeId))?.deals.length, 0);
    assert.equal((await db.getShoeAuditBundle(raceShoe.shoeId))?.reveal?.reason, "CONCURRENT_ROTATION");

    await db.pool.query("DELETE FROM shoe_secrets WHERE shoe_id = $1", [nextShoe.shoeId]);
    await assert.rejects(db.ensureTableShoe(tableId), /active seed is missing/);
    await assert.rejects(
      db.replaceTableShoe(tableId, db.pool, "ROTATED"),
      /active seed is missing/,
    );
    assert.equal((await db.getTableShoe(tableId))?.shoeId, nextShoe.shoeId);
  } finally {
    await db.pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
