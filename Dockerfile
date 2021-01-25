FROM node:14.15.4-buster

RUN apt-get -y update && \
    apt-get -y install --no-install-recommends \
    python3 make gcc g++ git avahi-daemon dbus nano ffmpeg android-tools-adb android-tools-fastboot \
  && rm -rf /var/lib/apt/lists/*

RUN chmod 4755 /bin/ping
RUN mkdir /hoobs

WORKDIR /usr/src/hoobs
VOLUME /hoobs

COPY bridge ./bridge
COPY controllers ./controllers
COPY interface ./interface
COPY scripts ./scripts
COPY server ./server

COPY bin/hoobs-docker ./bin/hoobs
COPY default-docker.json ./default.json
COPY package.json ./
COPY LICENSE ./

COPY docker /

RUN npm install --only=production

RUN [ "${AVAHI:-1}" = "1" ] || (rm -rf /etc/services.d/avahi \
    /etc/services.d/dbus \
    /etc/cont-init.d/40-dbus-avahi)

CMD [ "bin/hoobs" ]
