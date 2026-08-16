// OCTOPOINTS — ARCHIVED v2.150, deactivated (not deleted)
//
// Built in v2.147, redesigned minimal in v2.148. Live device testing in
// v2.149 returned "Unauthorized" (error code KT-CT-1111) on first real
// test. Most likely cause: an account reader/API permissions gap on this
// account rather than a bug in the code below — the queries themselves
// were confirmed live via schema reference (a similarly named field,
// octoplusRewards, is deprecated, but that's a different system — the
// Octoplus Rewards marketplace — entirely; loyaltyPointsBalance and
// loyaltyPointLedgers are the correct, distinct fields for this feature).
//
// Deactivated in loadBilling() to stop spending API calls on a feature
// that isn't returning data. A possible lead for resolving this: the
// login JWT may itself carry the account's permission scopes, which could
// confirm the permissions theory directly. If that gets resolved via the
// Octopus developer forum, reinstate by moving this block back into
// loadBilling() (right after the "Last bill" try/catch, before `return
// anyLive`) and removing the `$('octo-block').classList.add('hidden')`
// line that replaced it.
//
// Requires: #octo-block, #octo-balance, #octo-balance-gbp, #octo-history
// in index.html (left in place, currently just permanently hidden), and
// krakenAccountUserId (extracted from the login JWT's sub claim in
// getKrakenToken() — that extraction itself was left in place since it's
// used nowhere else specific to Octopoints and is cheap to keep).

async function loadOctopoints() {
  try {
    const balanceData = await krakenGQL(`
      query LoyaltyPointsBalance($input: LoyaltyPointsBalanceInput!) {
        loyaltyPointsBalance(input: $input) { loyaltyPoints totalMonetaryAmount }
      }`, { input: { accountNumber: store.creds.accountNumber } });
    const bal = balanceData?.loyaltyPointsBalance;
    if (bal && typeof bal.loyaltyPoints === 'number') {
      $('octo-balance').textContent = `${bal.loyaltyPoints.toLocaleString('en-GB')} pts`;
      $('octo-balance-gbp').textContent = typeof bal.totalMonetaryAmount === 'number'
        ? `≈ £${(bal.totalMonetaryAmount / 100).toFixed(2)}` : '';
      $('octo-block').classList.remove('hidden');

      if (krakenAccountUserId) {
        try {
          const ledgerData = await krakenGQL(`
            query LoyaltyPointLedgers($input: LoyaltyPointLedgersInput!) {
              loyaltyPointLedgers(input: $input) { value ledgerType reasonCode postedAt }
            }`, { input: { accountUserId: krakenAccountUserId } });
          // Capped at 25 rather than shown in full — a reasonable ceiling
          // for a long-standing account without risking an unbounded list,
          // and generous since this only ever renders once the person has
          // deliberately expanded it.
          const entries = (ledgerData?.loyaltyPointLedgers || [])
            .slice()
            .sort((a, b) => +new Date(b.postedAt) - +new Date(a.postedAt))
            .slice(0, 25);
          $('octo-history').innerHTML = entries.map(e => {
            const isCredit = e.ledgerType === 'CREDIT';
            const pts = Math.abs(parseInt(e.value, 10) || 0);
            const label = (e.reasonCode || '').replace(/[_-]+/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase())
              || (isCredit ? 'Points earned' : 'Points redeemed');
            const date = new Date(e.postedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
            return `<div class="bh-item"><span class="l">${label} — ${date}</span><span class="v${isCredit ? ' credit' : ''}"${isCredit ? '' : ' style="color:var(--text-dim);"'}>${isCredit ? '+' : '−'}${pts} pts</span></div>`;
          }).join('');
        } catch (err) {
          logIssue('Octopoints history', err);
          $('octo-history').innerHTML = '';
        }
      }
    } else {
      $('octo-block').classList.add('hidden');
    }
  } catch (err) {
    logIssue('Octopoints balance', err);
    $('octo-block').classList.add('hidden');
  }
}
