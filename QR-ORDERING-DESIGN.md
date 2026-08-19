# Ordering from the table by QR code

**Status:** sketch, for review. Nothing here is built.
**Date:** 2026-08-19

A printed code on each table. A guest scans it, sees the menu, orders, and the
order arrives against that table.

## How much of this already exists

More than you would expect. The public website already renders the menu from
`/api/menus`, has a working cart, and posts to `/api/orders` — anonymously,
because `POST /api/orders` is deliberately in the `PUBLIC` list. It already
sends the field this whole feature turns on:

```js
body: JSON.stringify({
  items, total, name, phone, email,
  order_type: orderType,
  table_number: orderTable,     // ← already sent, already accepted
  notes, status: 'new'
})
```

The API normalises that through `normaliseTableId`, so `5`, `05` and `5.0` are
the same table. The order lands in D1, appears on the kitchen board, and shows
up as an open check against the table. Courses, timing and the check screens all
key off the same value.

So the backend is not the work. **The work is identity, trust and workflow.**

## The three code changes

1. **Read the table out of the URL** on the website, prefill it, and lock the
   field so a guest cannot type someone else's table. Force
   `order_type: 'dine-in'` — a QR on table 4 is not a delivery.
2. **A way to mint and print the codes**, one per table.
3. **A "your order is with the kitchen" state.** The cart already shows an order
   reference after a successful post, which is most of it.

Everything else below is a decision, not a line of code.

---

## The URL and the token

The obvious scheme is `fufutcoffee.com/order?t=4`. It is also forgeable by
anyone who can count, from anywhere in the world.

Better: give each table a secret that is not its number.

```
https://fufutcoffee.com/order?t=T4&k=9f3ac1d8
```

`k` is a random per-table key, stored on the `tables` row, checked by the API
before an order is accepted. It does not need to be long — it is protecting
against idle mischief, not a determined attacker — but it must not be derivable
from the table number.

Two properties worth having:

- **Rotatable.** If a code leaks or a printed card walks off, a manager
  regenerates that table's key and reprints one card. Every other table is
  unaffected.
- **Not a session.** The key identifies a *table*, never a person. It grants
  exactly one power: attach an order to this table.

### Also require the table to be seated

A key on its own still lets somebody order at 3am from another city. Requiring
`tables.status = 'occupied'` costs nothing and closes that: an order can only be
placed at a table the floor has actually seated.

This is a real decision though — it means a guest who sits down before anyone
seats them cannot order. In a café where guests seat themselves, that is wrong.
Two ways out, and they suit different rooms:

- **Waiter seats first** — strict, matches table service, and the seating action
  already exists in the POS.
- **The first scan seats the table** — the QR itself marks it occupied. Better
  for self-seating, and it makes the floor plan more accurate rather than less.
  The atomic claim already written for tables handles the race if two people
  scan at once.

I would start with the second, and let the first be a setting if the room turns
out to need it.

---

## Does it go straight to the kitchen?

The sharpest question here, and it is about trust, not code.

**Straight to the kitchen** is fastest and feels modern. It also means anyone
who photographs a code can send food to a pass at any time, and the kitchen has
no idea whether a human is sitting there.

**A waiter accepts it first** costs seconds and removes that entirely. The order
appears on the floor screen, a waiter glances at the table, taps accept, and
only then does it print. It also gives the guest something honest to look at:
*sent · seen by the floor · being cooked*.

The existing status vocabulary is `new → confirmed → fulfilled`, and `confirmed`
is sitting there unused by the customer flow. A QR order can land as `new` and
become `confirmed` when a waiter accepts it, with the kitchen board filtering on
`confirmed` for QR-sourced orders only. Staff-entered orders keep going straight
through, exactly as now.

**Recommendation: waiter accepts.** The delay is a few seconds. The alternative
is a stranger being able to cook food.

---

## Who pays, and when

**Pay at the end, on the table's open check.** The order joins the check, the
guest pays a person, and nothing about money handling changes. Everything needed
already exists — open checks, split payments, tips, the shift-close gate.

**Pay online at order time** means integrating Telebirr or CBE properly:
gateway, verification, evidence, refunds, reconciliation, and the question of
what happens when a payment succeeds and the order fails. That is a project of
its own, not an addition to this one.

Start with the first. It is genuinely useful on day one, and it does not put
money anywhere new.

---

## What happens when the internet is down

This is where the feature meets the rest of the system, and it is worth being
deliberate rather than discovering it during an outage.

A QR pointing at `fufutcoffee.com` reaches Cloudflare, not the café. During a
country-wide outage the guest's phone may still have mobile data while the
building has none — so the cloud would happily accept an order the kitchen will
never see. **That case is already handled:** the venue heartbeat gate refuses
anonymous orders when the box stops checking in, and the guest is told ordering
is briefly closed rather than being charged for food nobody starts.

There is a second option worth considering. A QR pointing at the **box's own
address** on the café WiFi keeps QR ordering working during an outage — the
order goes straight to the kitchen sitting ten metres away. It only works for
guests on the café network, and it needs the box reachable over HTTPS for a
decent mobile experience.

They are not exclusive: the printed code can carry the public URL, and the
café's WiFi captive DNS can resolve that hostname to the box when inside.
That is the arrangement worth aiming at eventually. It is not day-one work.

---

## What the guest sees

Roughly, and worth designing properly with someone who knows the room:

1. Scan → menu opens, headed **Table 4** so a mis-scan is obvious immediately
2. Browse, add, adjust quantities — the existing cart
3. Send → *your order is with the floor*
4. Accepted → *being prepared*, with the reference already shown today
5. More rounds append to the same check rather than starting a new order

Step 5 matters more than it looks: a table orders in rounds, and the open-check
and course work already supports exactly that.

---

## What this does not solve

- **A guest who scans and leaves.** An order accepted by a waiter is a waiter's
  judgement; that is the point of the accept step.
- **Table numbers that disagree with reality.** If cards are moved between
  tables, the system is confidently wrong. Print the table name on the card,
  large — a human check beats a clever one.
- **Language.** The menu is English today. A café in Addis may want Amharic on
  the guest-facing page even if staff screens stay as they are.
- **Allergens and modifiers.** Modifiers exist in the POS; whether guests should
  see the same set is a menu decision, not a technical one.

---

## Suggested order of work

1. Per-table keys: column, generator, and a manager screen to print cards
2. The `/order` page: read `t` and `k`, lock the table, force dine-in
3. Server-side check: valid key, table seated (or seat on first scan)
4. The accept step on the floor screen, and `confirmed` gating the kitchen
5. Rounds appending to the open check
6. Later, if wanted: online payment, Amharic, the box-local URL

Steps 1 to 4 are the smallest version that is honest and safe. That is where I
would stop and watch a real service before adding anything.

---

## Decisions needed before building

1. **Waiter accepts, or straight to the kitchen?**
2. **Does the first scan seat the table, or must a waiter seat it first?**
3. **Pay at the end, or online at order time?** (Strong recommendation: at the
   end, to begin with.)
4. **Should guests see modifiers and notes**, or a simplified menu?
