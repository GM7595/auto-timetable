# PDF export font

`NotoSansJP-Regular.ttf` is a static weight-400 TrueType instance of Noto Sans JP.
It is self-hosted and loaded only when the user requests a PDF export. Event data
is not sent to a font service or a PDF-generation server.

Source: [Google Fonts / Noto Sans JP](https://github.com/google/fonts/tree/main/ofl/notosansjp)

The original `NotoSansJP[wght].ttf` was downloaded from that directory on
2026-10-18 and converted without subsetting its character repertoire:

```sh
python3 -m fontTools.varLib.instancer 'NotoSansJP[wght].ttf' wght=400 --output NotoSansJP-Regular.ttf
```

The font and its static instance are distributed under the SIL Open Font License
1.1. See `OFL-NotoSansJP.txt` for the original copyright notice and license.
