import { describe, it, expect } from 'vitest';
import { loadSendGameweekReceipt } from '../support/seams.js';
import type { GameweekPicks, SendReceiptRequest } from '../support/seams.js';
import { buildReceiptDeps } from '../support/fakes.js';
import { LEAGUE_LIGUE_1, GAMEWEEK_15 } from '../support/fixtures.js';

/**
 * POST /v1/leagues/{leagueId}/gameweeks/{gameweekId}/receipt — the
 * consolidated gameweek email added post-release (see
 * pdlc/jeu-des-pronos/12-email-receipt.v1.md). Deliberately separate from
 * submitPrediction.test.ts's per-match email assertions: this endpoint's
 * whole reason to exist is sending one email for a gameweek, not one per
 * match, so its own suite proves that shape directly.
 */

const req = (overrides: Partial<SendReceiptRequest> = {}): SendReceiptRequest => ({
  league_id: LEAGUE_LIGUE_1,
  gameweek_id: GAMEWEEK_15,
  pseudo: 'Lio_92',
  email: 'lio92@example.com',
  ...overrides,
});

const TWO_MATCH_GAMEWEEK: GameweekPicks = {
  league_name: 'Ligue 1',
  gameweek_number: 15,
  picks: [
    {
      home_team: 'Olympique de Marseille',
      away_team: 'Paris Saint-Germain',
      predicted_home_score: 2,
      predicted_away_score: 1,
      starts_at: new Date('2026-08-10T19:00:00Z'),
    },
    {
      home_team: 'AS Monaco',
      away_team: 'LOSC Lille',
      predicted_home_score: 0,
      predicted_away_score: 0,
      starts_at: new Date('2026-08-11T18:00:00Z'),
    },
  ],
};

describe('buildReceiptEmail', () => {
  it('formats the subject as "Confirmation de pronos {league} J{number}"', async () => {
    const api = await loadSendGameweekReceipt();

    const { subject } = api.buildReceiptEmail('Lio_92', TWO_MATCH_GAMEWEEK);

    expect(subject).toBe('Confirmation de pronos Ligue 1 J15');
  });

  it('formats the text body as "Salut {pseudo}", one "{home} {H} - {A} {away}" line per match, then "Bonne chance"', async () => {
    const api = await loadSendGameweekReceipt();
    // Equal-length home names here so padding (tested separately below)
    // doesn't change the line shape this test is checking.
    const evenNames: typeof TWO_MATCH_GAMEWEEK = {
      league_name: 'Ligue 1',
      gameweek_number: 15,
      picks: [
        { home_team: 'AS Monaco', away_team: 'Paris Saint-Germain', predicted_home_score: 2, predicted_away_score: 1, starts_at: new Date() },
        { home_team: 'FC Nantes', away_team: 'LOSC Lille', predicted_home_score: 0, predicted_away_score: 0, starts_at: new Date() },
      ],
    };

    const { text } = api.buildReceiptEmail('Lio_92', evenNames);

    expect(text).toBe(
      'Salut Lio_92\n\n' +
        'Voici la confirmation que nous avons bien reçu tes pronos:\n\n' +
        'AS Monaco  2 - 1  Paris Saint-Germain\n' +
        'FC Nantes  0 - 0  LOSC Lille\n\n' +
        'Bonne chance',
    );
  });

  it('right-pads the shorter home team name in the text body so scores line up', async () => {
    const api = await loadSendGameweekReceipt();

    const { text } = api.buildReceiptEmail('Lio_92', TWO_MATCH_GAMEWEEK);
    const scoreColumn = text
      .split('\n')
      .filter((line) => line.includes(' - '))
      .map((line) => line.indexOf(' - '));

    // Both lines' " - " separator lands at the same column, i.e. the
    // shorter home team name ("AS Monaco") was padded to match the
    // longer one ("Olympique de Marseille").
    expect(new Set(scoreColumn).size).toBe(1);
  });

  it('renders the html body as a table with the home team right-aligned and the away team left-aligned, like the webpage', async () => {
    const api = await loadSendGameweekReceipt();

    const { html } = api.buildReceiptEmail('Lio_92', TWO_MATCH_GAMEWEEK);

    expect(html).toContain('<table');
    expect(html).toContain('text-align:right');
    expect(html).toContain('text-align:left');
    expect(html).toContain('Olympique de Marseille');
    expect(html).toContain('>2</td>');
    expect(html).toContain('>1</td>');
    expect(html).toContain('Paris Saint-Germain');
  });

  it('escapes player-controlled team/pseudo text in the html body', async () => {
    const api = await loadSendGameweekReceipt();
    const withMarkup: typeof TWO_MATCH_GAMEWEEK = {
      league_name: 'Ligue 1',
      gameweek_number: 15,
      picks: [
        { home_team: '<b>Home</b>', away_team: 'Away', predicted_home_score: 1, predicted_away_score: 0, starts_at: new Date() },
      ],
    };

    const { html } = api.buildReceiptEmail('<script>x</script>', withMarkup);

    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('<b>Home</b>');
    expect(html).toContain('&lt;b&gt;Home&lt;/b&gt;');
  });
});

describe('POST .../receipt', () => {
  it('sends one email covering every match in the gameweek and reports email_sent: true', async () => {
    const api = await loadSendGameweekReceipt();
    const { deps, sentEmails } = buildReceiptDeps(TWO_MATCH_GAMEWEEK);

    const res = await api.handleSendGameweekReceipt(req(), deps);

    expect(res.status).toBe(200);
    expect(res.body.email_sent).toBe(true);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe('lio92@example.com');
    expect(sentEmails[0].subject).toBe('Confirmation de pronos Ligue 1 J15');
    expect(sentEmails[0].html).toContain('<table');
  });

  it('reports email_sent: false, not an error, when the mailer itself fails', async () => {
    const api = await loadSendGameweekReceipt();
    const { deps } = buildReceiptDeps(TWO_MATCH_GAMEWEEK, { mailerResult: false });

    const res = await api.handleSendGameweekReceipt(req(), deps);

    expect(res.status).toBe(200);
    expect(res.body.email_sent).toBe(false);
  });

  it('404s when the pseudo has no predictions in this gameweek, rather than sending an empty email', async () => {
    const api = await loadSendGameweekReceipt();
    const { deps, sentEmails } = buildReceiptDeps({ league_name: 'Ligue 1', gameweek_number: 15, picks: [] });

    const res = await api.handleSendGameweekReceipt(req(), deps);

    expect(res.status).toBe(404);
    expect(sentEmails).toHaveLength(0);
  });

  it('404s when the league/gameweek pair itself does not exist', async () => {
    const api = await loadSendGameweekReceipt();
    const { deps, sentEmails } = buildReceiptDeps(null);

    const res = await api.handleSendGameweekReceipt(req(), deps);

    expect(res.status).toBe(404);
    expect(sentEmails).toHaveLength(0);
  });

  it('400s on a malformed email rather than silently sending nowhere', async () => {
    const api = await loadSendGameweekReceipt();
    const { deps, sentEmails } = buildReceiptDeps(TWO_MATCH_GAMEWEEK);

    const res = await api.handleSendGameweekReceipt(req({ email: 'not-an-email' }), deps);

    expect(res.status).toBe(400);
    expect(sentEmails).toHaveLength(0);
  });

  it('400s on a blank pseudo', async () => {
    const api = await loadSendGameweekReceipt();
    const { deps, sentEmails } = buildReceiptDeps(TWO_MATCH_GAMEWEEK);

    const res = await api.handleSendGameweekReceipt(req({ pseudo: '' }), deps);

    expect(res.status).toBe(400);
    expect(sentEmails).toHaveLength(0);
  });
});
