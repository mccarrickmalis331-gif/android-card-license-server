# Android Card License Server

Node.js card-key verification server for Android apps.

## Features

- Visual admin panel
- Generate license cards by minute, hour, day, month, or year
- Activate and bind cards to a device
- Heartbeat checks
- Timestamp validation
- MD5 request signature
- RC4 encrypted request and response payloads
- Delete one card or all cards

## Render

Use these settings when creating a Render Web Service:

- Service type: Web Service
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Environment: Free

Environment variables:

```text
APP_ID=demo_android_app
APP_SECRET=change_this_app_secret
RC4_KEY=change_this_rc4_key
ADMIN_TOKEN=change_this_admin_token
```

After deployment, open:

```text
https://YOUR-SERVICE.onrender.com/health
```

Then update Android `LicenseConfig.BASE_URL` to:

```text
https://YOUR-SERVICE.onrender.com
```
