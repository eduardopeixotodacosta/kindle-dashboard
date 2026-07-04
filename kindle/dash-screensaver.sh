#!/bin/sh
# Token Dashboard — modo screensaver no Kindle.
# Desenha o dashboard por cima do screensaver quando o aparelho bloqueia e
# devolve a tela ao framework quando desbloqueia (o framework redesenha o livro).
# Nao segura a tela acesa: o Kindle dorme normalmente; apos suspender, a imagem
# congela com o ultimo dado baixado (o PNG carrega o horario da renderizacao).
#
# Reusa dash-loop.pid e dash-loop.stop para que start/stop/status do instalador
# funcionem igual nos dois modos e para que loop e screensaver nunca rodem juntos.
#
# Parar:  touch /mnt/us/dash-loop.stop   (ou matar o processo)
# Log:    /mnt/us/dash-screensaver.log

PC="${PC:-}"
IMG=/mnt/us/dash.png
INTERVAL="${INTERVAL:-45}"     # segundos entre downloads enquanto bloqueado
FULL_EVERY="${FULL_EVERY:-20}" # full-refresh (flash anti-ghosting) a cada N desenhos
WIFI_RETRY_EVERY="${WIFI_RETRY_EVERY:-3}" # tenta recuperar WiFi apos N falhas seguidas
POLL=3                          # segundos entre checagens de estado do powerd
STOP=/mnt/us/dash-loop.stop
PIDFILE=/mnt/us/dash-loop.pid
FBINK=/usr/bin/fbink

# 0* rejeita zero e zeros a esquerda ("08" viraria octal invalido no $(( )))
case "$INTERVAL" in ''|*[!0-9]*|0*) INTERVAL=45;; esac
case "$FULL_EVERY" in ''|*[!0-9]*|0*) FULL_EVERY=20;; esac
case "$WIFI_RETRY_EVERY" in ''|*[!0-9]*|0*) WIFI_RETRY_EVERY=3;; esac
if [ -z "$PC" ]; then
  echo "[dash-screensaver] PC is required. Set PC to http://<PC_IP>:<PORT>/dash.png"
  exit 2
fi

# instancia unica entre os dois modos: mata o processo anterior, se houver
if [ -f "$PIDFILE" ]; then
  OLD=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then kill "$OLD" 2>/dev/null; sleep 1; fi
fi
echo $$ > "$PIDFILE"

# limpa estado deixado por um dash-loop morto com kill -9 (prop presa em 1
# impede o aparelho de entrar no screensaver); no-op quando ja esta em 0
lipc-set-prop com.lab126.powerd preventScreenSaver 0 2>/dev/null

# so remove os arquivos compartilhados se este processo ainda for o dono:
# o trap POSIX e adiado ate o comando corrente (sleep/curl) terminar, entao
# a instancia antiga morre depois que a nova ja escreveu o proprio pid
cleanup() {
  if [ "$(cat "$PIDFILE" 2>/dev/null)" = "$$" ]; then
    rm -f "$PIDFILE" "$IMG.tmp"
  fi
}
# sem exit no handler o script sobreviveria ao kill do takeover
trap 'cleanup; exit 143' INT TERM
trap cleanup EXIT

in_screensaver() {
  # firmwares variam no texto exato; aceita "Screen Saver", "screenSaver" etc.
  ST=$(lipc-get-prop com.lab126.powerd status 2>/dev/null)
  case "$ST" in *[Ss]creen*[Ss]aver*) return 0;; esac
  ST=$(lipc-get-prop com.lab126.powerd state 2>/dev/null)
  case "$ST" in *[Ss]creen*[Ss]aver*) return 0;; esac
  return 1
}

reconnect_wifi() {
  STATE=$(lipc-get-prop com.lab126.wifid cmState 2>/dev/null)
  echo "[dash-screensaver] $(date) recuperando WiFi (estado=${STATE:-desconhecido})"
  lipc-set-prop com.lab126.wifid enable 1 >/dev/null 2>&1
  wpa_cli -i wlan0 reassociate >/dev/null 2>&1
  sleep 8
}

draw() {
  in_screensaver || return 0   # estado pode ter mudado durante sleep 2 ou curl
  if [ $((draws % FULL_EVERY)) -eq 0 ]; then
    "$FBINK" -f -c >/dev/null 2>&1            # flash completo (limpa ghosting)
  fi
  "$FBINK" -g file="$IMG" -W GC16 >/dev/null 2>&1
  draws=$((draws + 1))
}

fetch_and_draw() {
  if curl -fsS --connect-timeout 10 --max-time 30 "$PC" -o "$IMG.tmp" 2>/dev/null && [ -s "$IMG.tmp" ]; then
    mv "$IMG.tmp" "$IMG"
    failures=0
    draw
  else
    rm -f "$IMG.tmp"
    failures=$((failures + 1))
    echo "[dash-screensaver] $(date) falha no curl (${failures} seguida(s))"
    # apos suspender, o WiFi morre: a tentativa so ajuda antes da suspensao
    if [ $((failures % WIFI_RETRY_EVERY)) -eq 0 ]; then
      reconnect_wifi
    fi
  fi
}

rm -f "$STOP"
mode=awake
draws=0
failures=0
elapsed="$INTERVAL"   # forca download imediato ao entrar no screensaver
last_tick=$(date +%s)
echo "[dash-screensaver] start $(date) pid=$$ PC=$PC interval=${INTERVAL}s poll=${POLL}s"

while [ ! -f "$STOP" ]; do
  # last_tick e capturado logo antes do sleep: gap mede apenas sleep +
  # suspensao, sem inflar com curl lento (que dispararia wake falso)
  now=$(date +%s)
  gap=$((now - last_tick))

  if in_screensaver; then
    if [ "$mode" = awake ]; then
      mode=locked
      echo "[dash-screensaver] $(date) bloqueado — assumindo a tela"
      sleep 2                    # deixa o framework desenhar o screensaver antes
      draws=0
      elapsed="$INTERVAL"        # proximo tick baixa na hora
      [ -s "$IMG" ] && draw      # mostra o ultimo PNG imediatamente
    elif [ "$gap" -gt $((POLL * 10)) ] && [ -s "$IMG" ]; then
      # relogio saltou = acordou de suspensao; o framework pode ter redesenhado
      # o screensaver proprio por cima do dashboard — restaura o ultimo PNG
      echo "[dash-screensaver] $(date) acordou da suspensao (gap=${gap}s) — redesenhando"
      draw
    fi
    elapsed=$((elapsed + gap))
    if [ "$elapsed" -ge "$INTERVAL" ]; then
      elapsed=0
      fetch_and_draw
    fi
  else
    if [ "$mode" = locked ]; then
      mode=awake
      echo "[dash-screensaver] $(date) desbloqueado — devolvendo a tela ao Kindle"
      failures=0
    fi
  fi

  last_tick=$(date +%s)
  sleep "$POLL"
done

echo "[dash-screensaver] parado $(date) (encontrou $STOP)"
