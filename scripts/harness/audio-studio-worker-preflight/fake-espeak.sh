#!/usr/bin/env bash
# espeak-ng con fallo inyectado: cuenta las llamadas en $PREFLIGHT_ESPEAK_COUNT y falla en la llamada número
# $PREFLIGHT_ESPEAK_FAIL_AT (simula que el motor de voz se cae a mitad del episodio). El resto delega en el real.
n=$(( $(cat "$PREFLIGHT_ESPEAK_COUNT" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$PREFLIGHT_ESPEAK_COUNT"
if [ -n "$PREFLIGHT_ESPEAK_FAIL_AT" ] && [ "$n" -eq "$PREFLIGHT_ESPEAK_FAIL_AT" ]; then echo "fallo inyectado en la llamada $n" >&2; exit 1; fi
exec "$PREFLIGHT_REAL_ESPEAK" "$@"
