#!/usr/bin/env bash
# רץ בכל פעם שה-Codespace עולה (postStartCommand).
# מקים את השרת, חושף אותו בשתי דרכים (פורט ציבורי של GitHub + מנהרת Cloudflare),
# בודק אותו מבפנים ומבחוץ, ודוחף דוח מלא לענף codespace-report כדי שאפשר לקרוא
# אותו מרחוק דרך api.github.com (app.github.dev חסום בנטפרי, api פתוח).
# הכול best-effort: גם אם צעד נכשל, ממשיכים ומדווחים.
set -uo pipefail

LOG=/tmp/kav-boot.log
exec > >(tee -a "$LOG") 2>&1
echo "=================================================="
echo "boot.sh התחיל: $(date -u '+%Y-%m-%d %H:%M:%SZ')"

DOMAIN="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
NAME="${CODESPACE_NAME:-unknown}"
GH_URL="https://${NAME}-3000.${DOMAIN}"
echo "כתובת GitHub צפויה: $GH_URL"

# --- 1. פורט ציבורי של GitHub (גיבוי ל-portsAttributes) ---
PORT_VIS="unknown"
if command -v gh >/dev/null 2>&1; then
  if gh codespace ports visibility 3000:public -c "$NAME" >/tmp/port.log 2>&1; then
    PORT_VIS="public (gh)"
  else
    PORT_VIS="gh-failed"; cat /tmp/port.log
  fi
fi
echo "נראות פורט GitHub: $PORT_VIS"

# --- 2. הפעלת השרת מתוך /app ---
if curl -s -o /dev/null --max-time 3 "http://127.0.0.1:3000/"; then
  echo "השרת כבר מאזין"
else
  echo "מפעיל את השרת מ-/app..."
  cd /app || { echo "שגיאה: /app לא קיים"; exit 0; }
  EXT_PATH="${EXT_PATH:-8}" PORT=3000 nohup ./start.sh >/tmp/kav.log 2>&1 &
  echo "start.sh הופעל (PID $!)"
fi

# --- 3. מנהרת Cloudflare (כתובת חלופית נקייה, בלי דף-אזהרה, בלי טוקן) ---
CF_URL="none"
if [ ! -x /usr/local/bin/cloudflared ]; then
  echo "מוריד cloudflared..."
  curl -fsSL -o /usr/local/bin/cloudflared \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    && chmod +x /usr/local/bin/cloudflared || echo "הורדת cloudflared נכשלה"
fi
if [ -x /usr/local/bin/cloudflared ]; then
  pkill -f "cloudflared tunnel" 2>/dev/null || true
  nohup /usr/local/bin/cloudflared tunnel --no-autoupdate --url http://localhost:3000 \
    >/tmp/cf.log 2>&1 &
  echo "cloudflared הופעל, ממתין לכתובת..."
  for i in $(seq 1 30); do
    CF_URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" /tmp/cf.log | head -1)
    [ -n "$CF_URL" ] && break
    CF_URL="none"; sleep 2
  done
  echo "כתובת Cloudflare: $CF_URL"
fi

# --- 4. המתנה שהשרת יאזין, ואז selftest ---
UP="no"
for i in $(seq 1 60); do
  curl -s -o /dev/null --max-time 3 "http://127.0.0.1:3000/" && { UP="yes"; break; }
  sleep 1
done
echo "השרת מאזין: $UP"
SELFTEST='{"ok":false,"error":"server did not start"}'
[ "$UP" = "yes" ] && SELFTEST=$(curl -s --max-time 60 "http://127.0.0.1:3000/selftest" || echo '{"ok":false,"error":"selftest timeout"}')

# --- 5. בדיקה חיצונית אמיתית של שתי הכתובות (כמו שימות פונה) ---
ext_probe () {
  local u="$1"
  [ -z "$u" ] || [ "$u" = "none" ] && { echo '{"code":"skip","body":""}'; return; }
  local code body
  code=$(curl -s -m 25 -o /tmp/ext.txt -w "%{http_code}" "$u/" || echo "000")
  body=$(head -c 140 /tmp/ext.txt | tr '\n\r"' '   ')
  echo "{\"code\":\"$code\",\"body\":\"$body\"}"
}
echo "בודק את $GH_URL מבחוץ..."; GH_PROBE=$(ext_probe "$GH_URL"); echo "$GH_PROBE"
echo "בודק את $CF_URL מבחוץ..."; CF_PROBE=$(ext_probe "$CF_URL"); echo "$CF_PROBE"

# --- 6. /trystream: הוכחת חילוץ אמיתי (אדון עולם, מקודד) ---
TRY='{"skip":true}'
if [ "$UP" = "yes" ]; then
  echo "מריץ /trystream..."
  TRY=$(curl -s -m 150 "http://127.0.0.1:3000/trystream?q=%D7%90%D7%93%D7%95%D7%9F%20%D7%A2%D7%95%D7%9C%D7%9D" \
    || echo '{"ok":false,"error":"trystream timeout"}')
  echo "$TRY"
fi

# --- 7. דוח לענף codespace-report ---
echo "דוחף דוח..."
REPORT_DIR=/tmp/csr
cd "$(git -C /workspaces/kav-shirim rev-parse --show-toplevel 2>/dev/null || echo /workspaces/kav-shirim)" || cd /workspaces/kav-shirim
git worktree remove --force "$REPORT_DIR" 2>/dev/null || true
rm -rf "$REPORT_DIR"
if git worktree add -B codespace-report "$REPORT_DIR" 2>/tmp/wt.log; then
  cd "$REPORT_DIR"
  git rm -rqf . 2>/dev/null || true
  cat > report.json <<EOF
{
  "time": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "codespace": "$NAME",
  "github_url": "$GH_URL",
  "github_yemot": "$GH_URL/yemot",
  "github_external": $GH_PROBE,
  "cloudflare_url": "$CF_URL",
  "cloudflare_yemot": "$CF_URL/yemot",
  "cloudflare_external": $CF_PROBE,
  "port_visibility": "$PORT_VIS",
  "server_up": "$UP",
  "trystream": $TRY,
  "selftest": $SELFTEST
}
EOF
  cp "$LOG" boot.log 2>/dev/null || true
  git add -A
  git -c user.email="bot@kav.local" -c user.name="kav-codespace" commit -qm "report $(date -u '+%H:%M:%SZ')" || true
  git push -f origin codespace-report >/tmp/push.log 2>&1 && echo "הדוח נדחף" || { echo "דחיפה נכשלה:"; cat /tmp/push.log; }
else
  echo "worktree נכשל:"; cat /tmp/wt.log
fi

echo "=== סיכום ==="
echo "GitHub : $GH_URL/yemot"
echo "Cloudflare: $CF_URL/yemot"
echo "boot.sh הסתיים: $(date -u '+%H:%M:%SZ')"
echo "=================================================="
