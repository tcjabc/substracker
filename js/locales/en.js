// English: every word the app shows, by key (js/i18n.js t()). English is bundled and is the
// fallback for anything another locale lacks. Another locale is a copy of this file with the same
// keys and the same {placeholders} (tests/i18n.node.test.js checks both).
//
// Keys are namespaced by screen. Plural forms are `key.one` / `key.other` (and whatever forms the
// language has: zh-TW has only `.other`), chosen by t(key, { count }). Keys ending in "Html" hold a
// few tags (such as <strong>); keep the same tags in a translation.
//
// Not here, on purpose: user data (item, group and category names, the preset names in
// js/services.js), the 12 recovery words, the Import with AI prompt (js/import-ai-prompt.js) and
// the JSON it asks for, CSV column headers and values, backup and sync formats, currency codes.
//
// LEGAL: keys marked "legal check" are legal or privacy wording, copied as-is. Each translation of
// them needs a legal check for that language before it ships.

export default {
  // Shared words
  'common.back': 'Back',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.continue': 'Continue',
  'common.exportBackupFirst': 'Export a backup first',
  'common.save': 'Save',

  // Tabs and page titles
  'tab.insights': 'Insights',
  'tab.money': 'Money',
  'tab.sections': 'Sections',
  'tab.settings': 'Settings',

  // Money tab
  'money.addExpense': 'Add expense',
  'money.addIncome': 'Add income',
  'money.empty.text': "Add your income and the things you pay for. It's stored on this device, with optional end-to-end encrypted sync between your devices.", // legal check
  'money.empty.title': 'Nothing here yet',
  'money.summary.label': 'Summary',
  'money.view.grid': 'Cards',
  'money.view.grid.title': 'Card view',
  'money.view.label': 'View',
  'money.view.list': 'List',
  'money.view.list.title': 'List view',
  'money.view.wallet': 'Wallet',
  'money.view.wallet.title': 'Wallet view',

  // Sort groups (Money tab)
  'sort.az': 'A to Z',
  'sort.items': 'Items',
  'sort.items.hint': 'most first',
  'sort.title': 'Sort groups',
  'sort.total': 'Total',
  'sort.total.hint': 'high to low',

  // Add / edit sheet
  'form.category': 'Category',
  'form.category.placeholder': 'e.g. Music',
  'form.currency': 'Currency',
  'form.cycle.annual': 'Annual',
  'form.cycle.expense': 'Billing cycle',
  'form.cycle.monthly': 'Monthly',
  'form.cycle.once': 'Once',
  'form.date': 'Date',
  'form.delete': 'Delete',
  'form.domain': 'Website domain',
  'form.domain.hint': 'for logo',
  'form.domain.placeholder': 'e.g. example.com',
  'form.emoji': 'Emoji',
  'form.emoji.placeholder': 'e.g. 🍜',
  'form.kind.expense': 'Expense',
  'form.kind.income': 'Income',
  'form.name': 'Name',
  'form.name.placeholder.expense': 'e.g. Netflix',
  'form.notes': 'Notes',
  'form.notes.placeholder.expense': 'Shared with family, billed to card ending 1234…',
  'form.optional': 'optional',
  'form.plan': 'Plan',
  'form.plan.placeholder': 'e.g. Premium',
  'form.price.expense': 'Price',
  'form.renewal.expense': 'Next renewal',
  'form.title.newExpense': 'New expense',
  'form.type': 'Type',

  // Insights
  'insights.currency.label': 'Currency',

  // Settings
  'settings.ai': 'Import with AI',
  'settings.ai.button': 'Start',
  'settings.ai.hint': 'Turn statements into items with an AI chat you choose. The app sends nothing.', // legal check
  'settings.csv': 'Export as CSV',
  'settings.csv.copy': 'Copy CSV',
  'settings.csv.copy.label': 'Copy CSV, for spreadsheets, not a backup',
  'settings.csv.download': 'Download CSV',
  'settings.csv.download.label': 'Download CSV, for spreadsheets, not a backup',
  'settings.csv.fallback': "Couldn't copy. Select the CSV below and copy it.",
  'settings.csv.hint': "For spreadsheets, not a backup: items only, and it can't be imported.",
  'settings.currency': 'Default currency',
  'settings.data': 'Data',
  'settings.export': 'Export',
  'settings.export.button': 'Export',
  'settings.export.hint': 'Download all items and settings as JSON.',
  'settings.export.hint.native': 'Save or share a backup file of all items and settings.',
  'settings.import': 'Import',
  'settings.import.button': 'Import',
  'settings.import.hint': 'Load a JSON backup, then choose merge or replace.',
  'settings.install': 'Install',
  'settings.install.androidHtml': '<strong>Android:</strong> open in Chrome, tap the menu, then <em>Install app</em>.',
  'settings.install.button': 'Install app',
  'settings.language': 'Language',
  'settings.language.auto': 'Same as device',
  'settings.install.iosHtml': '<strong>iPhone / iPad:</strong> open in Safari, tap Share, then <em>Add to Home Screen</em>.',
  'settings.language': 'Language',
  'settings.motion': 'Reduce motion and effects',
  'settings.motion.hint': 'Flat charts and no animation. Follows your device until you change it.',
  'settings.preferences': 'Preferences',
  'settings.storageNote': "Your data is stored locally in this browser (IndexedDB). With optional sync, changes are end-to-end encrypted before they leave the device, so the relay can't read them. Logos are loaded from Google's favicon service using only the domain you enter.", // legal check
  'settings.storageNote.native': "Your data is stored locally on this device. With optional sync, changes are end-to-end encrypted before they leave the device, so the relay can't read them. Logos are loaded from Google's favicon service using only the domain you enter.", // legal check
  'settings.sync.label': 'Sync between devices',
  'settings.sync.title': 'Sync',
  'settings.theme': 'Appearance',
  'settings.theme.dark': 'Dark',
  'settings.theme.light': 'Light',
  'settings.theme.system': 'System',

  // Sync sheet
  'sync.button.setup': 'Set up',
  'sync.choice.legend': 'How to join',
  'sync.choice.merge': "Merge this device's data into the household",
  'sync.choice.merge.hint': "This device's items are sent to every device in the household. Where an item was edited in both places, the later edit wins, so changes from this device can overwrite newer ones made on other devices.",
  'sync.choice.replace': "Use the household's data",
  'sync.choice.replace.hint': "This device's items are replaced by the household's. Items that are only on this device will be lost, so export a backup first if you might want them.",
  'sync.devices': 'Devices',
  'sync.devices.text': 'Use the 12 words to add a device: on it, open Settings → Sync → Join with 12 words.',
  'sync.join': 'Join',
  'sync.join.hint': 'On a device that already syncs, open Settings → Sync → Show recovery words.',
  'sync.join.placeholder': '12 words, separated by spaces',
  'sync.join.words': 'Recovery words',
  'sync.joinOpen': 'Join with 12 words',
  'sync.last': 'Last sync',
  'sync.needsWords': 'Sync needs the 12 words on this device. Join again with your recovery words.',
  'sync.never': 'Never',
  'sync.now': 'Sync now',
  'sync.pending': 'Changes waiting to send',
  'sync.recovery.saved': "I've saved these words",
  'sync.recovery.title': 'Your 12 recovery words',
  'sync.recovery.warning': "Write these down. Anyone with them can read your data; if you lose every device and the words, the synced copy can't be recovered.", // legal check
  'sync.scan.camera': 'Camera',
  'sync.scan.hint': 'Point the camera at the QR code under Show recovery words on the other device. The camera picture stays on this device.', // legal check
  'sync.scan.start': 'Scan QR code',
  'sync.scan.stop': 'Stop scanning',
  'sync.setup.text': "Your data stays stored on this device. Sync is optional and end-to-end encrypted: your data is encrypted on your device before it syncs. There's no account. 12 recovery words are the only key, and they can't be recovered if you lose them.", // legal check
  'sync.start': 'Start sync',
  'sync.state.off': 'Off',
  'sync.status': 'Status',
  'sync.summary.off': 'Off',
  'sync.title': 'Sync',
  'sync.turnOff': 'Turn off sync on this device',
  'sync.words.copy': 'Copy words',
  'sync.words.hide': 'Hide recovery words',
  'sync.words.label': 'Recovery words',
  'sync.words.qr': 'QR code of the 12 recovery words',
  'sync.words.qrCaption': "The same 12 words as a QR code, to photograph or read with another device's camera app.",
  'sync.words.show': 'Show recovery words',

  // Import with AI
  'ai.error.copy': 'Copy error for your AI',
  'ai.error.textLabel': 'Error text to copy',
  'ai.import': 'Import',
  'ai.prompt.copy': 'Copy prompt',
  'ai.prompt.fallback': "Couldn't copy. Select the prompt below and copy it.",
  'ai.prompt.label': 'The prompt',
  'ai.prompt.show': 'Show the prompt',
  'ai.prompt.step1': '1. Copy the prompt',
  'ai.prompt.step1.text': 'It describes the format the app needs and asks the AI to check unclear dates with you instead of guessing.',
  'ai.prompt.step2': '2. Ask your AI chat',
  'ai.prompt.step2.text': 'Paste the prompt into the AI chat you chose, attach photos or PDFs of your statements, and answer its questions.',
  'ai.prompt.step3': '3. Bring back the reply',
  'ai.reply.label': 'Paste the reply',
  'ai.reply.pickFile': 'Or pick a file',
  'ai.review': 'Review',
  'ai.review.errorText': "Some rows can't be imported as they are. Fix the date or cycle here, or send the errors back to your AI chat.",
  'ai.review.rows': 'Rows to import',
  'ai.slide.help': 'Drag to the end, or use the arrow keys. It unlocks after a moment.',
  'ai.slide.label': "Slide to confirm you've read this",
  'ai.slide.tick': "Or tick: I've read this",
  'ai.tool.text': "Look for one that says it keeps no chat logs, doesn't train on your data, and has a temporary or incognito chat mode.", // legal check
  'ai.tool.title': 'Choosing a tool',
  'ai.totals.hint': 'Nothing is saved until you choose Merge or Replace all.',
  'ai.totals.title': 'Selected totals',
  'ai.warning.lead': 'Peek Budget has no connection to any AI service. The app never sends anything: what you upload is between you and the provider you choose.', // legal check
  'ai.warning.point1': 'Privacy claims belong to each provider and can change. Check them yourself before you upload anything.', // legal check
  'ai.warning.point2': 'Remove account numbers, card numbers and names first. The app only needs the merchant, amount and date.', // legal check
  'ai.warning.point3': 'AI can misread documents, so check every row before you import.', // legal check
  'ai.warning.point4': 'Nothing is imported until you confirm.', // legal check

  // Dates and cycles (js/util.js)
  'cycle.perMonth': '/ mo',
  'cycle.perYear': '/ yr',
  'date.renews.today': 'Renews today',
  'date.renews.tomorrow': 'Renews tomorrow',
  'date.renews.inDays.one': 'Renews in {count} day',
  'date.renews.inDays.other': 'Renews in {count} days',
  'date.renews.on': 'Renews {date}',
  'date.payment.today': 'Payment today',
  'date.payment.tomorrow': 'Payment tomorrow',
  'date.payment.inDays.one': 'Payment in {count} day',
  'date.payment.inDays.other': 'Payment in {count} days',
  'date.payment.on': 'Payment {date}',
};
