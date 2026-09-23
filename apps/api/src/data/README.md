# Data files shipped with the API

## egm96-15.pgm — EGM96 geoid undulation, 15-arc-minute grid

Source: GeographicLib geoid dataset `egm96-15`
(https://geographiclib.sourceforge.io/C++/doc/geoid.html, file
`egm96-15.pgm` from `egm96-15.tar.bz2`, generated 2009-08-29 from the NGA
EGM96 model). Licence: MIT/X11, as for all GeographicLib data
(https://geographiclib.sourceforge.io/LICENSE.txt). The underlying EGM96
model is public-domain work of the US National Geospatial-Intelligence
Agency.

Format: binary PGM (`P5`), 1440 × 721 samples of 16-bit big-endian pixels,
origin 90°N 0°E, 15' spacing, row-major from the north pole southwards and
from the Greenwich meridian eastwards. The header comments carry the
decoding: `N = Offset + Scale × pixel` (Offset −108, Scale 0.003), and the
stated worst-case bilinear interpolation error is 1.152 m (RMS 0.040 m).

Read by `src/common/geoid.ts`, which turns a device's WGS84 ellipsoidal
altitude into an orthometric (EGM96) height for every punch that carries
one. Copied into `dist/data/` by `scripts/copy-api-assets.mjs` at build.
