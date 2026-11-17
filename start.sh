#!/bin/sh
# מפעיל את ספק ה-PO Token ברקע ואז את השרת.
# אם אחד מהם מת, המכולה יוצאת, והמאחסן מרים אותה מחדש.
set -e

echo "מפעיל את ספק ה-PO Token..."
node /opt/bgutil/build/main.js --port 4416 &
POT_PID=$!

# ממתינים שהספק יאזין. בלעדיו הבקשה הראשונה ליוטיוב תיכשל.
i=0
while [ $i -lt 40 ]; do
  if curl -s -o /dev/null "http://127.0.0.1:4416/ping"; then
    echo "ספק ה-PO Token מאזין"
    break
  fi
  # אם התהליך מת, אין טעם להמשיך לחכות
  if ! kill -0 "$POT_PID" 2>/dev/null; then
    echo "אזהרה: ספק ה-PO Token נפל בהפעלה; ממשיכים בכל זאת"
    break
  fi
  i=$((i + 1))
  sleep 1
done
[ $i -ge 40 ] && echo "אזהרה: ספק ה-PO Token לא ענה בזמן; ממשיכים בכל זאת"

# אם הספק נופל אחר כך, מפילים את המכולה כדי שתעלה מחדש נקייה
( while kill -0 "$POT_PID" 2>/dev/null; do sleep 15; done
  echo "ספק ה-PO Token נפל; מפיל את המכולה"; kill -TERM 1 ) &

echo "מפעיל את השרת..."
exec node server.js
