// The text "Import with AI" copies for the person to paste into an AI chat of their own choosing,
// together with their statements. The app never sends it anywhere. It names no AI product or
// company. The schema it describes is the one js/import-ai.js reads; keep the two in step.

import { CURRENCIES } from './util.js';
import { DEFAULT_CATEGORIES } from './services.js';

export const AI_IMPORT_PROMPT = `I want to import my recurring payments, income and (if I say so) one-off transactions into my budgeting app, Peek Budget. I'll share photos, screenshots or PDFs of my statements, receipts or bills.

Before you start:
- If I haven't said, ask me whether I want only recurring items (subscriptions, bills, regular income) or one-off transactions too.
- If any date is unclear, unreadable or missing, ask me. Never guess a date, an amount or a currency.
- If you can't tell whether something repeats monthly or yearly, ask me.
- Ask your questions in plain text, without any JSON, and wait for my answers.

Privacy rules:
- Leave out account numbers, card numbers, IBANs, reference numbers and any person's name (mine or anyone else's).
- Use only the merchant or payer name, the amount and the date. For a payment to or from a person, use a general name such as "Rent" or "Transfer".

When everything is clear, reply with only the JSON, nothing else: no explanation before or after it and no code fences. Use exactly this shape:

{
  "version": 1,
  "rows": [
    {
      "name": "Example Streaming",
      "amount": 390,
      "currency": "TWD",
      "cycle": "monthly",
      "nextDate": "2026-12-05",
      "category": "Entertainment",
      "type": "expense"
    }
  ]
}

Fields (every field must be present on every row; category may be ''):
- "name": the merchant or payer, as short text (at most 80 characters).
- "amount": a positive number with a dot for decimals and no currency symbol or thousands separator, e.g. 1290.5.
- "currency": one of ${CURRENCIES.join(', ')}. Use the currency shown on the document. For a currency not in this list, ask me, and leave that item out unless I tell you which currency to use.
- "cycle": "monthly", "annual" or "one-off". If something repeats on another schedule (weekly, every two weeks, quarterly, or anything else), write the schedule as you see it, e.g. "weekly", and the app will flag it for me to fix.
- "nextDate": a date as YYYY-MM-DD. For "monthly" and "annual", the next payment date if the document shows it, otherwise the date of the most recent payment (the app works out the next one). For "one-off", the date it happened.
- "category": a short category such as ${DEFAULT_CATEGORIES.filter((c) => c !== 'Other').join(', ')}; use "" if none fits. Use "" for income.
- "type": "expense" for money going out, "income" for money coming in. Amounts are always positive; the type says which way the money goes.

List each item once. If the same subscription appears on several statements, give one row for it with its latest date.`;
