#!/usr/bin/env bash
# Диагностика доступа к EWS: печатает только HTTP-коды, пароль не выводит.
#   curl -sL https://raw.githubusercontent.com/anu-rich/dislokacia/main/pipeline/diag.sh | bash
cd /root/dislokacia/pipeline 2>/dev/null || { echo "нет /root/dislokacia/pipeline"; exit 1; }
if [ ! -f config.env ] || grep -q 'ВПИШИ_ПАРОЛЬ' config.env; then
  cp -n config.env.example config.env
  echo ">>> Введи пароль от почты (не показывается), Enter:"; read -r -s PW < /dev/tty
  sed -i "s|^EWS_PASS=.*|EWS_PASS=$PW|" config.env; unset PW; chmod 600 config.env
fi
grep -q '^EWS_URL=' config.env || echo 'EWS_URL=https://autodiscover.kmtf.kmg.kz/EWS/Exchange.asmx' >> config.env
set -a; . ./config.env; set +a
SOAP='<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><s:Header><t:RequestServerVersion Version="Exchange2013_SP1"/></s:Header><s:Body><m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape><m:FolderIds><t:DistinguishedFolderId Id="inbox"/></m:FolderIds></m:GetFolder></s:Body></s:Envelope>'
try() { # $1 label, $2 auth flag, $3 user, $4 url
  code=$(curl -s -o /tmp/ews_out -w "%{http_code}" -m 40 $2 -u "$3:$EWS_PASS" -H "Content-Type: text/xml; charset=utf-8" -H "X-AnchorMailbox: $EWS_EMAIL" --data-binary "$SOAP" "$4")
  body=$(head -c 160 /tmp/ews_out | tr -d '\n\r')
  echo "$1 -> HTTP $code | $(echo "$body" | sed 's/  */ /g')"
}
echo "== GET без авторизации:"
for u in https://mail.kmg.kz/EWS/Exchange.asmx https://mail.kmg.kz/ews/exchange.asmx https://autodiscover.kmtf.kmg.kz/EWS/Exchange.asmx https://mail.kmtf.kmg.kz/EWS/Exchange.asmx; do
  echo "$u -> $(curl -s -o /dev/null -w '%{http_code}' -m 20 "$u")"
done
echo "== POST GetFolder(inbox) с авторизацией:"
U1="$EWS_USER"; U2="kmg\\${EWS_USER%%@*}"; U3="kmtf\\${EWS_USER%%@*}"; U4="${EWS_USER%%@*}"
for H in https://autodiscover.kmtf.kmg.kz/EWS/Exchange.asmx https://mail.kmg.kz/EWS/Exchange.asmx; do
  echo "-- $H"
  for U in "$U1" "$U2" "$U3" "$U4"; do
    try "NTLM  user=$U" "--ntlm" "$U" "$H"
  done
  try "BASIC user=$U1" "--basic" "$U1" "$H"
  try "NEGOT user=$U1" "--negotiate" "$U1" "$H"
done
echo "== Autodiscover (POST, NTLM):"
AD='<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006"><Request><EMailAddress>'"$EWS_EMAIL"'</EMailAddress><AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema></Request></Autodiscover>'
code=$(curl -s -o /tmp/ad_out -w "%{http_code}" -m 40 --ntlm -u "$U1:$EWS_PASS" -H "Content-Type: text/xml" --data-binary "$AD" https://mail.kmg.kz/autodiscover/autodiscover.xml)
echo "autodiscover -> HTTP $code"; grep -o '<EwsUrl>[^<]*</EwsUrl>\|<ErrorCode>[^<]*</ErrorCode>\|<Message>[^<]*</Message>' /tmp/ad_out | head -5
rm -f /tmp/ews_out /tmp/ad_out
echo "== exchangelib (fetch_mail.py, EWS_URL=$EWS_URL):"
. .venv/bin/activate 2>/dev/null && python fetch_mail.py 2>&1 | tail -3
echo "== конец"
