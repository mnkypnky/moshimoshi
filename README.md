# Shared file workspace

A simple local web app for two approved users to:
- sign in with fixed credentials
- create folders
- upload images, videos, and PDF files
- download files later

## Run locally

```bash
cd /Users/prinks/moshimoshi
npm install
SHARE_USER_1='your-user-1' SHARE_PASS_1='your-pass-1' SHARE_USER_2='your-user-2' SHARE_PASS_2='your-pass-2' node server.js
```

Then open http://localhost:3000.

## Notes
- There is no sign-up flow.
- The app uses local disk storage for uploads and SQLite for metadata.
- A decoy page is shown if authentication is bypassed or if login fails three times in a session.
