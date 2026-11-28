# BisFoto Editor

BisFoto Editor er et lokalt fotostudie til web og tablet med billedbibliotek, redigering, eksport og fotobøger. Originaler og redigeringer gemmes i browseren.

## Start lokalt

Kør `python -m http.server 8080` fra repositoryets rod og åbn [BisFoto Editor lokalt](http://localhost:8080/dist/). Appen kan hostes statisk fra `dist/` uden et byggetrin.

## Design

[Fotobibliotek](design/fotobibliotek.jpg) · [Fremkald](design/fremkald.jpg)

[Designoversigt](design/identitet.png) · [Designark i SVG](design/komponenter.svg) · [Hent de enkelte vektorkomponenter](design/komponenter/)

## Test

- Åbn [billedtestene](http://localhost:8080/tests/imaging.html) i browseren, mens den lokale server kører.
- Kør `node tests/library.mjs` med Playwright installeret og Microsoft Edge tilgængelig for at teste biblioteket.
