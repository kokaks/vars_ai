/**
 * REASONING SERVICE (Postgres / Neon version)
 * ----------------------------------------------------------------------------
 * Deliberately NOT where "understand what the client is saying" happens —
 * that's the ElevenLabs agent's own selected LLM (GPT-4o-mini/Claude/Gemini),
 * billed through your ElevenLabs credits. This module computes FACTS
 * deterministically (last visit date, last service, cadence) so the agent
 * only has to phrase them — it can't hallucinate a recommendation, and this
 * logic is unit-testable in a way a prompt never is.
 * ----------------------------------------------------------------------------
 */
const { DateTime } = require("luxon");
const { query } = require("../db");

async function computeReturningClientContext(clientId) {
  const clientResult = await query("SELECT * FROM clients WHERE id = $1", [clientId]);
  const client = clientResult.rows[0];
  if (!client) return null;

  const historyResult = await query(
    `SELECT a.*, s.name as service_name FROM appointments a
     LEFT JOIN services s ON s.id = a.service_id
     WHERE a.client_id = $1 AND a.status = 'completed'
     ORDER BY a.start_utc DESC LIMIT 5`,
    [clientId]
  );
  const history = historyResult.rows;

  if (history.length === 0) {
    return { client, isReturning: false };
  }

  const last = history[0];
  const daysSinceLast = DateTime.utc().diff(DateTime.fromJSDate(last.start_utc), "days").days;

  let avgCadenceDays = null;
  if (history.length >= 2) {
    const gaps = [];
    for (let i = 0; i < history.length - 1; i++) {
      gaps.push(
        DateTime.fromJSDate(history[i].start_utc).diff(DateTime.fromJSDate(history[i + 1].start_utc), "days").days
      );
    }
    avgCadenceDays = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  }

  const dueThreshold = avgCadenceDays ? avgCadenceDays * 0.85 : 30;
  const isDue = daysSinceLast >= dueThreshold;

  return {
    client,
    isReturning: true,
    lastService: last.service_label,
    lastBarberId: last.barber_id,
    lastVisitDaysAgo: Math.round(daysSinceLast),
    avgCadenceDays: avgCadenceDays ? Math.round(avgCadenceDays) : null,
    isDue,
  };
}

/**
 * Called by the tool route AFTER the agent has confirmed name+phone match
 * an existing client (per spec: never recommend before identity is
 * confirmed, to avoid cross-client mixups).
 */
async function getBookingRecommendation(clientId) {
  const ctx = await computeReturningClientContext(clientId);
  if (!ctx || !ctx.isReturning || !ctx.isDue) {
    return { shouldRecommend: false };
  }
  return {
    shouldRecommend: true,
    suggestedService: ctx.lastService,
    suggestedBarberId: ctx.lastBarberId,
    daysSinceLastVisit: ctx.lastVisitDaysAgo,
    facts: ctx,
  };
}

/**
 * Abusive/offensive-caller handling happens LIVE, in-call, via the
 * ElevenLabs agent's own system prompt + its selected LLM — see
 * docs/elevenlabs-agent-setup.md. No separate moderation API call, no
 * OpenAI key needed anywhere in this backend.
 */

module.exports = { computeReturningClientContext, getBookingRecommendation };
