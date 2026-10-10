FROM glitchtip/glitchtip:6.2.6@sha256:a3d8eb1b36c1e1603d55ab32711ea3dd8115874742a781a57391a62a16e0dff6
# GlitchTip 6.2.6 + symbolic 13.9 pass one-based columns to SourceMapCache.
# Keep this tiny compatibility fix explicit; refuse silent application on upgrades.
USER root
COPY fix-symbolic-column.py /tmp/fix-symbolic-column.py
RUN python /tmp/fix-symbolic-column.py
USER 5000
