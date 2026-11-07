FROM ghcr.io/wealthfolio/wealthfolio:3.12.0@sha256:5790528fcd9795b571176cad78bcca09e3fa5875ec20968356586939e154c3cb
COPY . /app/dist/
LABEL io.vibelife.origin="upstream-release-plus-investment-analysis" \
      io.vibelife.upstream-revision="f217ef5fbe76eecb5c5ceac53ee2514dee706c81" \
      io.vibelife.data-state="isolated-test"
