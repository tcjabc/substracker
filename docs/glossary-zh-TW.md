# Glossary: English → Traditional Chinese (Taiwan)

The app's core vocabulary for `js/locales/zh-TW.js`, so every screen uses the same word for the
same thing. Taiwan usage throughout, not Mainland (設定 not 设置, 資料 not 数据, 檔案 not 文件,
裝置 not 设备, 預設 not 默认, 清單 not 列表, 匯入/匯出 not 导入/导出).

**For the reviewer:** please mark any term that sounds unnatural or not like Taiwan usage, and
suggest the word you'd expect to see in a Taiwanese app. A change here is then made in every
string that uses the term. Terms marked ⚠ are the ones I'm least sure about.

## Conventions

- **Kept in Latin script:** Peek Budget, currency codes (TWD, USD, JPY…), JSON names and values in
  the import messages ("app", "items", "monthly", YYYY-MM-DD…), CSV, JSON, QR, AI, 3D, IndexedDB,
  Google, Chrome, Safari.
- **Not translated at all:** item, group and category names (the person's own), the preset names in
  `js/services.js`, the 12 recovery words (BIP-39 English list), the Import with AI prompt and its
  JSON, CSV headers and values, the developer sync screen, relay server messages.
- **Punctuation:** full-width ，。：；？！（）in Chinese sentences; 「」for quoting a word or a
  button name; 、for lists. Straight "double quotes" only around JSON names and values, because the
  AI and the app read them exactly.
- **Spacing:** a half-width space between Chinese and Latin letters or digits ("12 個復原詞",
  "匯出 CSV"), as Taiwanese Apple and Google apps do. No space between Chinese characters.
- **Counting:** items use 個 ("3 個項目"); rows in the AI review use 筆 ("3 筆").
- **Tone:** short and neutral, as on a phone. 「您」 is avoided where the sentence reads naturally
  without a pronoun; where one is needed, 「你」(the app's English is informal "you").
- **Money:** amounts come from the formatter. In zh-TW the formatter writes TWD as `$30,000` (Taiwan's
  own currency, CLDR's standard), other dollars as US$, HK$ and so on.

## Terms

| English | zh-TW | Notes |
|---|---|---|
| Peek Budget | Peek Budget | App name, never translated |
| item | 項目 | Anything in the list, income or expense; "3 個項目" |
| subscription | 訂閱 | Only where the English says subscription |
| plan (e.g. Premium) | 方案 | The form's Plan field |
| plan (a recurring payment, Insights notices) | 定期項目 | "3 plans need a renewal date" → 3 個定期項目需要續訂日期 |
| group | 群組 | A Money-tab group: a category, Uncategorised or Income |
| category | 類別 | |
| Uncategorised | 未分類 | |
| income | 收入 | |
| expense | 支出 | The item type |
| outgoings | 支出 | Total of expenses; same word as expense in Chinese |
| left over | 結餘 | Income minus outgoings |
| cash due | 應付金額 | "Cash due this month" → 本月應付金額 |
| due (this month) | 應付 | "due this month" → 本月應付 |
| paid (income, this month) | 入帳 | "paid this month" → 本月入帳 |
| nothing due | 無應付款項 | |
| renewal / renews | 續訂 | "Next renewal" → 下次續訂日; "Renews today" → 今天續訂 |
| payment (income date) | 入帳 | "Next payment" → 下次入帳日 |
| billing cycle | 計費週期 | 週 not 周 |
| How often (income) | 頻率 | |
| monthly | 每月 | |
| annual / yearly | 每年 | |
| one-off / once | 一次性 | |
| /mo, /yr | /月, /年 | |
| undated | 未設日期 | |
| other currency | 其他幣別 | 幣別 is Taiwan's usual word (not 货币/币种) |
| currency | 幣別 | |
| default currency | 預設幣別 | |
| average | 平均 | "Avg {amount}/mo" → 平均每月 {amount} |
| Money (tab) | 收支 | Income and expenses; short for the tab bar |
| Insights (tab) | 分析 | ⚠ 洞察 felt too literal |
| Settings (tab) | 設定 | |
| Wallet (view) | 錢包 | |
| Cards (view) | 卡片 | |
| List (view) | 清單 | |
| Sort | 排序 | |
| A to Z (sort) | 依名稱 | Chinese names have no A–Z; sorted by Zhuyin (ㄅㄆㄇㄈ), Taiwan's standard order |
| Total, high to low | 依總額，由高到低 | |
| Items, most first | 依項目數，由多到少 | |
| Summary | 摘要 | |
| Money card (the Money tab's summary card) | 摘要卡 | ⚠ 1.21.0; only in the due-soon setting's hint |
| due-soon chip | 即將到期標籤 | ⚠ 1.21.0; "3 due" on the chip → 3 筆到期 |
| {pct}% of income (the income card's gauge) | 佔收入 {pct}% | ⚠ 1.21.0; "under 1%" → 不到 1%; "No income this month" → 本月沒有收入 |
| Open Insights | 開啟分析 | 1.21.0; the Money card's button label for screen readers |
| Month / Year (Insights) | 月 / 年 | |
| 3D ring | 3D 環形圖 | |
| donut chart | 圓環圖 | |
| key (chart legend) | 圖例 | |
| Jump to now | 回到本月 | |
| Calendar (view) | 月曆 | The Money tab's fourth view; "Calendar view" → 月曆檢視. 月曆 (a month grid) rather than 行事曆 (a schedule app) |
| Previous / next month | 上個月 / 下個月 | |
| Today (calendar button) | 今天 | Its title "Go to this month" → 回到本月, as Jump to now |
| payment (on a calendar day) | 款項 | ⚠ Counted with 筆: "2 payments" → 2 筆款項 (income and expenses alike) |
| Cash due in {month} | {month}應付金額 | "2026年11月應付金額"; no space after the month |
| Nothing due | 無應付款項 | Also "Nothing due on this day" → 這天無應付款項 |
| Week starts on | 每週起始日 | ⚠ Settings; Automatic → 自動, then the weekday in （） |
| weekday names | 一 二 三 四 五 六 日 | The calendar's column heads use Intl's single characters (narrow), as Taiwanese calendars do; full names 星期一 in labels |
| Sync | 同步 | |
| household | 家庭 | ⚠ The set of devices that sync together; the English is "household" too |
| device | 裝置 | |
| relay | 中繼伺服器 | The server that passes encrypted changes between devices |
| end-to-end encrypted | 端對端加密 | 端對端 not 端到端 |
| recovery words | 復原詞 | ⚠ "12 recovery words" → 12 個復原詞; crypto wallets often say 助記詞 |
| household key | 家庭金鑰 | 金鑰 not 密钥 |
| join | 加入 | |
| set up | 設定 | Verb |
| turn off | 關閉 | |
| up to date | 已是最新 | |
| offline | 離線 | |
| QR code | QR 碼 | |
| scan | 掃描 | |
| camera | 相機 | |
| backup | 備份 | |
| export | 匯出 | |
| import | 匯入 | |
| replace / replace all | 取代 / 全部取代 | 取代 not 替换 |
| merge | 合併 | |
| file | 檔案 | |
| data | 資料 | |
| storage | 儲存空間 | |
| this device | 這台裝置 | |
| save / saved | 儲存 / 已儲存 | |
| delete / deleted | 刪除 / 已刪除 | |
| cancel | 取消 | |
| close / dismiss | 關閉 | |
| back | 返回 | |
| continue | 繼續 | |
| OK | 確定 | |
| Import with AI | 用 AI 匯入 | |
| prompt | 提示詞 | |
| AI chat (tool) | AI 聊天工具 | |
| statement | 帳單 | Bank or card statement |
| merchant | 商家 | |
| row (AI review) | 資料列 / 筆 | "Rows to import" → 要匯入的資料; counted with 筆 |
| review | 檢查 | The AI import step |
| duplicate | 重複 | |
| appearance | 外觀 | Light 淺色, Dark 深色, System 跟隨系統 |
| Reduce motion and effects | 減少動態與特效 | |
| language | 語言 | Same as device → 與裝置相同 |
| install app | 安裝應用程式 | |
| emoji | 表情符號 | |
| notes | 備註 | |
| name | 名稱 | |
| price / amount | 價格 / 金額 | |
| website domain | 網站網域 | |
| logo | 標誌 | ⚠ Many Taiwanese apps just write Logo |
| optional | 選填 | |
| required | 必填 | 1.21.1; beside the date in the add sheet (the counterpart of 選填) |
| More details (the add sheet's folded fields) | 更多資料 | ⚠ 1.21.1; alternatives 更多欄位, 其他資訊 |

## Default groups

The 11 groups the group picker and Import with AI suggest (`group.preset.*`). A name someone picks is
stored as plain text in the language in use at the time and is theirs from then on: it is never
translated or renamed afterwards.

| English | zh-TW | Notes |
|---|---|---|
| Housing | 居住 | ⚠ |
| Utilities | 生活帳單 | Household bills, internet included (水電瓦斯 would say water, power and gas only) |
| Food | 餐飲 | |
| Transport | 交通 | |
| Software & cloud | 軟體與雲端 | |
| Entertainment | 娛樂 | |
| Hobbies | 嗜好 | ⚠ |
| Education | 教育 | |
| Shopping | 購物 | |
| Health & fitness | 健康與運動 | ⚠ |
| Insurance & finance | 保險與金融 | ⚠ |

## Colour names

The group colours someone can pick, read aloud by screen readers and shown in the colour picker.

| Key | English | zh-TW |
|---|---|---|
| g1 | Gold | 金色 |
| g2 | Steel blue | 鋼藍色 |
| g3 | Terracotta | 赤陶色 |
| g4 | Sky | 天藍色 |
| g5 | Rose | 玫瑰色 |
| g6 | Plum | 梅紫色 |
| g7 | Olive | 橄欖綠 |
| g8 | Brown | 棕色 |
| g9 | Teal | 藍綠色 |
| g10 | Brick | 磚紅色 |
| w1 | Teal | 藍綠色 |
| w2 | Mint | 薄荷綠 |
| w3 | Red | 紅色 |
| w4 | Blue | 藍色 |
| w5 | Lilac | 淡紫色 |
| w6 | Navy | 海軍藍 |
| w7 | Orange | 橘色 |
| w8 | Violet | 紫羅蘭色 |
| w9 | Sky | 天藍色 |
| w10 | Forest | 森林綠 |
| w11 | Lime | 萊姆綠 |
| w12 | Magenta | 洋紅色 |
| w13 | Pink | 粉紅色 |
| w14 | Brown | 棕色 |
| w15 | Yellow | 黃色 |

橘色 (Taiwan) rather than 橙色.
