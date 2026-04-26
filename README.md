# ⚡ Signal Pro v5.0 — Quotex Binary Options

## Quick Start

### ধাপ ১ — .env সেটআপ
```env
GROQ_API_KEY=gsk_xxxx
GEMINI_API_KEY=AIxxxx
TELEGRAM_TOKEN=123:ABCxxx
ADMIN_USER=admin
ADMIN_PASS=admin123
```

### ধাপ ২ — Install & Run
```bash
npm install
node server.js
```

### ধাপ ৩ — Browser
```
http://localhost:3000/login
```

---

## Pages
| Page | URL | কাজ |
|---|---|---|
| Dashboard | `/dashboard` | Live chart + signals + strategy |
| Signals | `/signals` | Signal history + stats |
| Assets | `/assets` | Asset live/signal control |
| Strategies | `/strategies` | Drag & drop strategy management |
| Settings | `/settings` | Kill switch, TG chats, future signals |

---

## Asset Control (2 স্তর)
- **Live**: Candle chart তৈরি হবে
- **Signal**: সিগন্যাল generate হবে (Live ON থাকা আবশ্যক)

---

## Kill Switches
- **System Kill**: সব stream ও signal বন্ধ/চালু
- **AI Kill**: AI বন্ধ করলে শুধু strategy দিয়ে signal

---

## Telegram Chat IDs
Settings → Telegram Chat IDs এ add করুন।
প্রতিটি Chat ID এর আলাদা permission:
- Live Signal
- Future Signal (1 min আগে)
- Future Signal Result
- Live Signal Result
- Custom Message

---

## Strategies (16টি)
1. 2 Green 2 Red (OTC)
2. 3 Green 2 Red (OTC)
3. Fractal (OTC)
4. RSI Overbought/Oversold
5. RSI Centerline Cross
6. RSI Divergence
7. Color Sequence
8. Doji Reversal
9. S/R Bounce
10. Momentum Reversal
11. Engulfing Pattern
12. Hammer/Shooting Star
13. Pin Bar
14. Mean Reversion (OTC)
15. Volume Spike
16. Price Structure HH/HL

---

## Future Signal Upload
**Method 1:** Settings → Manual Upload
**Method 2:** Telegram Bot → paste list

Format:
```
1. 14:41 USD/COP OTC DOWN ⏬
2. 14:46 USD/COP OTC UP 🔼
```

---

## Win/Loss
Signal fire → 65 second পর auto check → result Telegram + Dashboard toast

---

## .env দরকার নেই পরিবর্তন
`API_HOST=api.gochart.in` এবং `API_PATH` already set আছে।
