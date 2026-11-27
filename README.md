# LUMA-Atelier

LUMA Atelier er et lokalt fotostudie til web og tablet med billedbibliotek, redigering, eksport og fotobøger. Originaler og redigeringer gemmes i browseren.

## Start lokalt

Kør `python -m http.server 8080` fra repositoryets rod og åbn [LUMA Atelier lokalt](http://localhost:8080/dist/). Appen kan hostes statisk fra `dist/` uden et byggetrin.

## Test

- Åbn [billedtestene](http://localhost:8080/tests/imaging.html) i browseren, mens den lokale server kører.
- Kør `node tests/library.mjs` med Playwright installeret og Microsoft Edge tilgængelig for at teste biblioteket.
