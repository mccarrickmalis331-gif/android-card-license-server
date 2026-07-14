FROM node:22-bookworm

ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH=$PATH:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/build-tools/35.0.0
ENV DEFAULT_LICENSE_SERVER=https://android-license-gateway-phone.pages.dev
ENV PORT=7860
ENV DPT_HOME=/app/tools/dpt

RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-17-jdk unzip wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/android-sdk/cmdline-tools \
  && wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O /tmp/cmdline-tools.zip \
  && unzip -q /tmp/cmdline-tools.zip -d /opt/android-sdk/cmdline-tools \
  && mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
  && rm /tmp/cmdline-tools.zip \
  && yes | sdkmanager --licenses >/dev/null \
  && sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY THIRD_PARTY_NOTICES.md ./

RUN mkdir -p tools work out \
  && wget -q https://github.com/iBotPeaches/Apktool/releases/download/v3.0.2/apktool_3.0.2.jar -O tools/apktool_3.0.2.jar \
  && wget -q https://github.com/luoyesiqiu/dpt-shell/releases/download/v2.12.0/dpt-shell-v2.12.0.zip -O /tmp/dpt-shell.zip \
  && echo "d897e6d47118827018056034070c142cf6861edcf8209627ddf7d551009d10ef  /tmp/dpt-shell.zip" | sha256sum -c - \
  && unzip -q /tmp/dpt-shell.zip -d /tmp/dpt-shell \
  && mkdir -p tools/dpt \
  && cp -R /tmp/dpt-shell/executable/. tools/dpt/ \
  && rm -rf /tmp/dpt-shell /tmp/dpt-shell.zip

EXPOSE 7860
CMD ["node", "server.js"]
