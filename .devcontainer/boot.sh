#!/usr/bin/env bash
# רץ בכל פעם שה-Codespace עולה (postStartCommand).
# 1. הופך את פורט 3000 לציבורי.
# 2. מפעיל את השרת מתוך /app (אותה תמונת Docker של הייצור).
# 3. בודק /selftest ו-/trystream.
# 4. דוחף דוח (כתובת + תוצאות) לענף codespace-report, כדי שאפשר לקרוא אותו
#    מרחוק דרך api.github.com (app.github.dev חסום בנטפרי, api פתוח).
# הכול best-effort: גם אם צעד נכשל, ממשיכים ומדווחים.
set -uo pipefail

LOG=/tmp/kav-boot.log
exec > >(tee -a "$LOG") 2>&1
echo "=================================================="
echo "boot.sh התחיל: $(date -u '+%Y-%m-%d %H:%M:%SZ')"

DOMAIN="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
NAME="${CODESPACE_NAME:-unknown}"
URL="https://${NAME}-3000.${DOMAIN}"
YEMOT_URL="${URL}/yemot"
echo "כתובת צפויה: $URL"

# --- 1. פורט ציבורי (גיבוי ל-portsAttributes שב-devcontainer) ---
PORT_VIS="unknown"
if command -v gh >/dev/null 2>&1; then
  if gh codespace ports visibility 3000:public -c "$NAME" >/tmp/port.log 2>&1; then
    PORT_VIS="public (gh)"
  else
    PORT_VIS="gh-failed (ראה portsAttributes)"
    cat /tmp/port.log
  fi
fi
echo "נראות פורט: $PORT_VIS"

# --- 2. הפעלת השרת מתוך /app (הקוד האפוי לתוך תמונת ה-Docker) ---
# אם כבר רץ (עלייה חוזרת), לא מפעילים שוב.
if curl -s -o /dev/null --max-time 3 "http://127.0.0.1:3000/"; then
  echo "השרת כבר מאזין, לא מפעיל שוב"
else
  echo "מפעיל את השרת מ-/app..."
  cd /app || { echo "שגיאה: /app לא קיים"; exit 0; }
  EXT_PATH="${EXT_PATH:-8}" PORT=3000 nohup ./start.sh >/tmp/kav.log 2>&1 &
  echo "start.sh הופעל (PID $!)"
fi

# --- 3. המתנה שהשרת יאזין, ואז בדיקות ---
echo "ממתין שהשרת יענה..."
SELFTEST="{}"
UP="no"
for i in $(seq 1 60); do
  if curl -s -o /dev/null --max-time 3 "http://127.0.0.1:3000/"; then
    UP="yes"; echo "השרת עונה (אחרי ${i}s)"; break
  fi
  sleep 1
done

if [ "$UP" = "yes" ]; then
  SELFTEST=$(curl -s --max-time 60 "http://127.0.0.1:3000/selftest" || echo '{"ok":false,"error":"selftest timeout"}')
  echo "--- selftest ---"; echo "$SELFTEST"
else
  echo "השרת לא ענה תוך 60 שניות. ראה /tmp/kav.log"
  SELFTEST='{"ok":false,"error":"server did not start"}'
fi

# --- 4. דוח לענף codespace-report ---
echo "דוחף דוח לענף codespace-report..."
REPORT_DIR=/tmp/csr
rm -rf "$REPORT_DIR"
REPO_ROOT="$(git -C /workspaces/kav-shirim rev-parse --show-toplevel 2>/dev/null || echo /workspaces/kav-shirim)"
cd "$REPO_ROOT" || cd /workspaces/kav-shirim

git worktree remove --force "$REPORT_DIR" 2>/dev/null || true
if git worktree add -B codespace-report "$REPORT_DIR" 2>/tmp/wt.log; then
  cd "$REPORT_DIR"
  # מנקים הכל מהענף הזה ושומרים רק את הדוח
  git rm -rqf . 2>/dev/null || true
  {
    echo "{"
    echo "  \"time\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\","
    echo "  \"codespace\": \"$NAME\","
    echo "  \"url\": \"$URL\","
    echo "  \"yemot_url\": \"$YEMOT_URL\","
    echo "  \"port_visibility\": \"$PORT_VIS\","
    echo "  \"server_up\": \"$UP\","
    echo "  \"selftest\": $SELFTEST"
    echo "}"
  } > report.json
  cp "$LOG" boot.log 2>/dev/null || true
  git add -A
  git -c user.email="bot@kav.local" -c user.name="kav-codespace" commit -qm "codespace report $(date -u '+%H:%M:%SZ')" || true
  if git push -f origin codespace-report >/tmp/push.log 2>&1; then
    echo "הדוח נדחף. לקרוא: contents/report.json?ref=codespace-report"
  else
    echo "דחיפת הדוח נכשלה:"; cat /tmp/push.log
  fi
else
  echo "יצירת worktree נכשלה:"; cat /tmp/wt.log
fi

echo "=== סיכום ==="
echo "כתובת לימות (שלוחה 7, ext.ini -> api_link): $YEMOT_URL"
echo "boot.sh הסתיים: $(date -u '+%H:%M:%SZ')"
echo "=================================================="
