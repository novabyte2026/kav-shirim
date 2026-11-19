#!/bin/sh
# השרת מנהל בעצמו את ספק ה-PO Token: מעלה אותו רק כשצריך ומכבה כשאין
# שימוש, כדי לא לחרוג מ-512MB של Render.
exec node --max-old-space-size=160 server.js
