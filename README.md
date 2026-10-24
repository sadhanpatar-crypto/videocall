# LiveCall — Professional Video Calling App

Mobile number + password se login, online users ke **naam** ki live list, aur ek click par HD video call (WebRTC).

## Features

- Register / Login: **mobile number + password** (password bcrypt se hash hota hai)
- Jo users online hain unka **naam** list mein dikhta hai (Available / In a call status ke saath)
- 1-to-1 HD video call: incoming call screen + ringtone, accept / decline
- Call controls: mute, camera on/off, front/back camera switch, call timer
- Mobile aur desktop dono par responsive dark UI
- Brute-force protection (login rate limit), JWT session (30 din)

## Project structure

```
server.js            Express + Socket.IO (auth, online presence, call signaling)
public/              Frontend (index.html, style.css, app.js)
test/smoke.js        End-to-end test  ->  npm test
render.yaml          One-click deploy config (Render)
Dockerfile           Docker deploy option
.github/workflows/   GitHub Actions CI
```

## Local par chalana

Node.js 18+ chahiye.

```bash
npm install
npm start
```

Browser mein `http://localhost:3000` kholiye. Do alag browser/tab (ya do phone) mein 2 account banaiye, dono online honge, ek dusre ko call kar sakte hain.

Test chalane ke liye: `npm test`

## GitHub par upload karna

```bash
git init
git add .
git commit -m "LiveCall video calling app"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

## Online deploy karna (zaruri)

> **Important:** GitHub Pages sirf static files chalata hai. Is app ko ek **Node.js server** chahiye (login + online list + call signaling ke liye). Isliye GitHub repo ko Render / Railway / Fly.io jaise host se connect kariye.

### Render (sabse aasaan)

1. [render.com](https://render.com) par GitHub se login kijiye
2. **New → Blueprint** → apna repo choose kijiye (`render.yaml` apne aap detect hoga)
3. Deploy hone ke baad aapko `https://...onrender.com` link milega — yahi aapka app hai

HTTPS automatic milta hai. **Camera/mic ke liye HTTPS zaruri hai** (localhost ke alawa).

### Environment variables

| Name | Kaam |
|------|------|
| `JWT_SECRET` | Login token secret. Production mein lamba random text set kijiye (Render blueprint khud bana deta hai) |
| `PORT` | Host automatic set karta hai |
| `DATA_DIR` | Users file ka folder (default `./data`) |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Optional TURN server (neeche dekhiye) |
| `STUN_URLS` | Optional, comma separated STUN servers |

## Dhyan dene wali baatein

1. **Users ka data:** Users `data/users.json` file mein save hote hain. Render ke **free plan par disk permanent nahi hota** — redeploy/restart par accounts ud sakte hain. Permanent chahiye to Render mein Persistent Disk lagaiye (`DATA_DIR` us disk par set kijiye) ya baad mein database (PostgreSQL/MongoDB) use kijiye.
2. **TURN server:** Kuch mobile networks / office WiFi par sirf STUN se video connect nahi hota. Apni app ko har network par pakka chalane ke liye TURN server lagaiye (jaise Metered, Twilio, ya khud ka coturn) aur `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` set kijiye.
3. **Mobile number format:** `9876543210`, `+91 98765 43210` aur `09876543210` — teeno same number maane jaate hain. Number ka OTP verification abhi nahi hai (sirf password login).
4. **Capacity:** Ye 1-to-1 calls ke liye bana hai. Group calls ke liye SFU (LiveKit/mediasoup) chahiye hoga.

## Customize

- App ka naam: `public/index.html` aur `public/style.css` (colors `:root` mein)
- Call timeout (ring 45 sec): `server.js` mein `endCall(call, 'missed')` wali line
