# Statsikka

Windows-työpöytäsovellus (Electron) pelitilastojen seuraamiseen: **Overwatch 2**, **Rocket League** ja **Rainbow Six Siege** (pelin omista ottelutallenteista). Käyttöliittymä on suomeksi.

## Asennus ja käynnistys

```
npm install
npm start
```

Tai kaksoisnapsauta `Kaynnista.bat` (käynnistää `Statsikka.vbs`:n kautta ilman jäävää konsoli-ikkunaa, joten taustatila toimii). Jos Electronin binääri ei lataudu `npm install`in yhteydessä, aja `node node_modules/electron/install.js`; ow-electronin binäärin lataus: `node node_modules/@overwolf/ow-electron/install.js`.

`npm start` ajaa `scripts/start.js`:n, joka käynnistää sovelluksen Overwolfin Electron-haarukalla (**ow-electron**, GEP-live-tiedot) ja putoaa tavalliseen Electroniin, jos ow-electron ei käynnisty lainkaan. Silloin kaikki muu toimii kuten ennen, mutta Overwolf-ominaisuudet ovat pois päältä.

## Asennuspaketti

```
npm install
npm run dist
```

`npm run dist` ajaa **ow-electron-builderin** (`@overwolf/ow-electron-builder` 26.9.3, electron-builderin Overwolf-haarukka), joka paketoi sovelluksen ow-electron-runtimella (44.9.0). Tulos syntyy kansioon `dist/`: asennusohjelma `Statsikka-Setup-1.2.0.exe` (+ `.blockmap` ja `latest.yml` päivityksiä varten) (NSIS, x64; valittava asennuskansio, työpöytäkuvake, asennus vain nykyiselle käyttäjälle) ja valmiiksi purettu `dist/win-unpacked/` (`Statsikka.exe`). Ikonit (`build/icon.ico`, `build/icon.png`) luo `node scripts/make-icons.js`. Ensimmäinen ajo lataa runtimen ja builderin työkalut verkosta (noin 160 Mt).

- Paketti on **allekirjoittamaton**: Windows SmartScreen varoittaa asennusohjelmaa avattaessa ("Lisätietoja" → "Suorita silti").
- **GEP-live-data** vaatii Overwolf-kehittäjäavaimen kuten ennenkin (ks. *Overwolf GEP*): avain annetaan Asetuksissa. Paketti on rakennettu ilman Overwolfin allekirjoitustunnuksia (`OW_CLI_EMAIL`, `OW_CLI_API_KEY`, `OW_BUILD_KEY`), joten rakennus varoittaa, ettei Overwolfin pakettien tarkistus välttämättä hyväksy pakettia tuotannossa. GEP:n toimintaa paketoidussa versiossa ei ole varmistettu; kaikki muu toimii ilman sitä.
- Savutesti paketista: `dist\win-unpacked\Statsikka.exe --smoke-test` (näkymätön, vie useita minuutteja).

Asetukset → **Tausta ja käynnistys**:

- **Toimi taustalla** (oletus päällä): ikkunan sulkeminen piilottaa Statsikan ilmaisinalueen (tray) kuvakkeeseen, ja pelien seuranta jatkuu. Kuvakkeen tooltip on "Statsikka"; kaksoisnapsautus tai valikon **Avaa Statsikka** tuo ikkunan esiin, valikosta pääsee myös suoraan **Overwatch 2 / Rocket League / Rainbow Six Siege** -näkymiin ja **Lopeta** sulkee sovelluksen kokonaan (myös **Ctrl+Q**). Kuvake on piirretty sovelluksen logosta (`assets/tray.png`, `assets/tray@2x.png`; luonti `node scripts/make-icons.js`). Windows voi piilottaa kuvakkeen ^-nuolen taakse.
- **Avaa pelin käynnistyessä** (oletus päällä): kun `tasklist`-tunnistus näkee pelin prosessin ilmestyvän, ikkuna näytetään `showInactive()`:lla (ei kohdistusta, ei `flashFrame`-vilkutusta, ei ilmoituksia, joten peli ei menetä näppäimistöä) ja näkymä vaihtuu kyseisen pelin Live-näkymään (OW2: Live-lobby). Tämä tapahtuu kerran per prosessin alku: peli joka oli jo käynnissä Statsikan käynnistyessä ei avaa ikkunaa, ja pelin sulkeminen + uusi käynnistys on uusi tapahtuma. Jos ikkuna on jo näkyvissä, vain vaihdetaan näkymä (ei kesken kirjoittamisen eikä vahvistusikkunan tai pelaajapaneelin ollessa auki). Kokoruudun (exclusive fullscreen) peli voi peittää ikkunan; ikkunaton kokoruutu toimii parhaiten.
- **Käynnistä Windowsin mukana** (oletus pois): kirjoittaa Windowsin käynnistyskohteen (`app.setLoginItemSettings`, polku = käytössä oleva ow-electron/Electron-binääri, argumentit `<sovelluskansio> --hidden` sekä GEP dev -kanava, jos se on käytössä ow-electronilla). `--hidden` käynnistää suoraan trayhin ilman ikkunaa; se vaatii "Toimi taustalla" -asetuksen. Asetus näyttää Windowsin todellisen tilan (esim. Tehtävienhallinnassa pois kytketty kohde näkyy pois päältä). Käynnistyskohde ohittaa `scripts/start.js`:n varakäynnistyksen (ei paluuta tavalliseen Electroniin, jos ow-electron ei käynnisty). Kohde osoittaa tähän kansioon: jos siirrät sovelluksen, kytke asetus pois ja päälle.
- **Kaynnista.bat uudelleen**, kun ikkuna on piilossa, tuo sen esiin (normaali näyttö ja kohdistus), koska käynnistät sen itse.

R6:n ja OW:n Live-näkymien yläreunassa on infoliuska ("Pelaajat näkyvät heti ottelun alussa, kun Overwolf-kehittäjäavain on asetettu…") ja nappi Asetuksiin, kun GEP ei ole käytössä.

## Päivitykset

Asennettu Statsikka (1.2.0 ja uudemmat) päivittää itsensä GitHub Releasesista (`electron-updater`, repo [`aksert/statsikka-releases`](https://github.com/aksert/statsikka-releases); omistaja on `package.json`in `build.publish[0].owner`-kentässä). Päivitys tarkistetaan 15 s käynnistyksen jälkeen ja 6 h välein, ladataan taustalla ja asennetaan, kun sovellus suljetaan kokonaan (tray-valikon "Lopeta" tai Ctrl+Q) tai kun painat Asetukset → **Päivitykset** → "Käynnistä uudelleen ja päivitä". Kehitysajossa (`npm start`) ja savutestissä päivitykset ovat pois käytöstä.

Julkaisu: nosta versio `package.json`issa (ja kirjoita halutessasi `release-notes/<versio>.md`), commitoi ja pushaa mainiin – GitHub Actions rakentaa ja julkaisee (`.github/workflows/release.yml`). Julkaisu tehdään vain, jos `v<versio>` ei vielä ole repossa `aksert/statsikka-releases`. Käsin: `gh workflow run release.yml` (`dry_run=true` tekee vain artefaktin). Vaatii repo-salaisuuden `RELEASES_TOKEN` (token, jolla on kirjoitusoikeus `aksert/statsikka-releases`-repoon).

Varavaihtoehto, paikallinen käsijulkaisu (`npm run dist` ei julkaise mitään):

1. Nosta versionumero `package.json`iin (esim. `1.3.0`).
2. `npm run dist`. Syntyy `dist/Statsikka-Setup-<versio>.exe`, `dist/Statsikka-Setup-<versio>.exe.blockmap` ja `dist/latest.yml`. Tiedostonimessä ei ole välilyöntejä (`nsis.artifactName`), koska GitHub korvaa välilyönnit pisteillä ja `latest.yml`:n viittaama nimi ei enää löytyisi.
3. Luo julkaisu (kolme tiedostoa, tagi `vX.Y.Z` vastaa versiota):

```
gh release create vX.Y.Z "dist/Statsikka-Setup-X.Y.Z.exe" "dist/Statsikka-Setup-X.Y.Z.exe.blockmap" dist/latest.yml --repo <owner>/statsikka-releases
```

Versio 1.1.0 ei sisällä päivittäjää, joten se tarvitsee yhden käsin tehdyn asennuksen (aja uusi asennusohjelma); siitä eteenpäin päivitykset tulevat itsestään. Päivitykset eivät ole allekirjoitettuja (kuten asennusohjelmakaan).

## Overwolf GEP: live-pelitiedot (R6 ja Overwatch 2)

**Mitä se antaa.** Overwolfin Game Events Provider (GEP) on sama tekniikka, jota Overwolfin R6 Tracker käyttää. Se kertoo pelin pelaajat ja luvut reaaliajassa, ilman ottelutallenteita:

- **Rainbow Six Siege, Live-peli**: kaikki 10 pelaajaa (tiimi, operaattori, tapot/kuolemat/apu, pisteet, terveys) näkyvät heti ottelun alussa, ennen kuin 1. kierroksen tallennetta on olemassa. Jokainen pelaaja yhdistetään omiin ottelutallenteisiisi `player_id`:llä (= tallenteen `profileID`): aiemmat kohtaamiset kanssa/vastaan, K/D, HS-%, epäilysmerkki ja "Edellinen: kanssa / vastaan" -merkki. Klikkaus avaa pelaajapaneelin (tuntemattomalle "Ei aiempia tallenteita"). Kun kierroksia tallentuu, HS-% täydentyy tallenteesta; ottelun ajan GEP on live-lähde. Ottelun alku (`match_start`) siirtää näkymän Live-peliin (sama automaattinen siirtymä, vain sovelluksen sisällä).
- **Overwatch 2, Live-lobby**: ottelun alkaessa lobby täyttyy itsestään (tiimikaverit → Oma tiimi, muut → Viholliset, oma BattleTag jää pois) ja "Hae kaikki" ajetaan automaattisesti kerran ottelua kohden (OverFastin rajoitukset ja välimuisti ennallaan; lobbyistunto kirjataan kohtaamishistoriaan). Korteilla näkyy GEP:n live-hero, K/D/A, vahinko ja paranto. Ottelun alku siirtää näkymän Live-lobbyyn.

**Käyttöönotto (henkilökohtainen kehitystila).**

1. Luo ilmainen tili osoitteessa [dev.overwolf.com](https://dev.overwolf.com/), lähetä sovellusidea ja odota, että Developer status on *Approved*. Avaa Profile → Developer Key → Generate key ja kopioi avain. (Vaihtoehto: jos Overwolf on avannut sinulle Developer Console -tilin osoitteessa console.overwolf.com, käytä Profile → API Keys -avainta ja tilin sähköpostia.)
2. Statsikka: Asetukset → **Overwolf (live-pelitiedot)** → liitä avain → **Ota käyttöön ja käynnistä uudelleen**. Sovellus tallentaa tunnuksen salattuna ja käynnistyy uudelleen (ow-electron lukee tunnukset vasta käynnistyessään). Käynnistä sen jälkeen peli normaalisti.
3. Rainbow Six on Overwolfin dev-kanavalla, joten "GEP dev -kanava" (`--owepm-package-channel=gep:dev`) on oletuksena päällä; Overwatch 2 on tuotannossa, mutta dev-kanava kattaa senkin. Poista valinta, kun peli on siirretty tuotantoon. Jos peli on käynnistetty järjestelmänvalvojana, käynnistä myös Statsikka järjestelmänvalvojana.

**Huomioita.** Kehitystila on tarkoitettu vain omaan käyttöön (ei jaettavaa, allekirjoitettua versiota). Ilman tunnusta sovellus toimii normaalisti ja GEP pysyy pois päältä. Asetuksissa näkyy tila (ei käytössä / odottaa tunnusta / valmis / peli käynnissä / virhe) ja diagnostiikka viimeisimmistä GEP-viesteistä.

**Yksityisyys.** Tunnus tallennetaan vain tälle koneelle Windowsin salauksella (Electronin `safeStorage`, tiedosto `%APPDATA%\statsikka\ow-credentials.bin`); jos salaus ei ole käytettävissä, tallennusta ei tehdä. Tunnusta ei kirjata lokiin, näytetä uudelleen eikä lähetetä minnekään Statsikan kautta: se annetaan vain ow-electronille ympäristömuuttujana (`OW_DEV_KEY` tai `OW_CLI_EMAIL` + `OW_CLI_API_KEY`). **Poista tunnukset** poistaa tiedoston. Overwolfin anonyymi analytiikka on kytketty pois (`disableAnonymousAnalytics`) eikä sovellus näytä mainoksia. Statsikka ei koskaan käynnistä, pysäytä tai muokkaa pelejä eikä kirjoita pelikansioihin.

## Oma profiili peleittäin ("kirjautuminen")

Jokaisen pelin (Overwatch 2, Rocket League, Rainbow Six Siege) ensimmäinen välilehti on **Oma profiili**, joka toimii myös kun peli ei ole käynnissä.

- Jos profiilia ei ole yhdistetty, näkyy kortti **Kirjaudu omaan profiiliin**: OW:ssa BattleTag + alusta (**Tarkista** / **Tallenna**), RL:ssä pelinimi + alusta, R6:ssa Ubisoft-nimi. **Salasanaa ei tarvita eikä kysytä**: Blizzard, Epic ja Ubisoft eivät tarjoa tilastoja kirjautumalla, joten profiili yhdistetään nimellä.
- Tallennus kirjoittaa samat asetukset kuin **Asetukset > Omat profiilit** (yksi totuuden lähde). Yhdistettynä näkyy sama osio kuin sivupalkin "Oma profiili" -koosteessa sekä **Vaihda profiili** ja **Kirjaudu ulos** (tyhjentää pelin profiiliasetuksen vahvistuksen jälkeen). OW:n kehityshistoria nollautuu vain, kun BattleTag tai alusta vaihtuu toiseen.

## Epätavalliset tilastot ("mahdollinen hakkeri")

Heuristinen merkki **Tarkkaile** (keltainen) tai **Mahdollinen hakkeri** (punainen). Merkkiä painamalla aukeavat perustelut (ei ponnahdusikkunaa) ja huomautus *Perustuu julkisiin tilastoihin, ei todiste huijaamisesta.* Pisteet: ≥ 4 = Mahdollinen hakkeri, 2–3 = Tarkkaile. **Asetukset > Epätavalliset tilastot: herkkyys**: Pois piilottaa merkit, Normaali, Tiukka laskee tasorajoja yhdellä.

- **Overwatch 2** (vain julkiset OverFast-tilastot, ei lisäpyyntöjä): final blowseja / kuolema, K/D, hitscan-hahmojen (Widowmaker, Ashe, Cassidy, Soldier: 76, Sojourn, Tracer, Sombra, Bastion, Baptiste, Ana) kriittisten osumien ja aseen tarkkuus (kolme eniten pelattua, vähintään 1 h) sekä erittäin korkea voitto-% ("mahdollinen smurffi"). Alle 20 pelillä tai 2 h peliajalla ei arvioida ("liian vähän pelejä arvioon"). Merkki näkyy profiilin otsikossa, live-lobbyn korteissa ja omassa profiilissa; profiilissa on myös **Tarkkuus**-osio lukuineen. Kaikki rajat ovat yhdessä taulukossa tiedostossa `src/main/suspicion.js` (`THRESHOLDS`), ja ne ovat arvioita, joita voi hioa.
- **Rainbow Six Siege, ottelutallenteista**: **Live-peli**, **Ottelut** ja **Pelaajat** arvioivat jokaisen tapaamasi pelaajan omista tallenteistasi kertyneillä summilla (`evaluateR6Replay`, rajat `R6_REPLAY_THRESHOLDS` tiedostossa `src/main/suspicion.js`): HS-% ≥ 65 / 80 (vähintään 20 tappoa), K/D ≥ 2,5 / 4,0 (vähintään 3 ottelua tai 15 kierrosta), tappoja/kierros ≥ 1,3 / 1,8 (vähintään 15 kierrosta) sekä yksittäisen ottelun merkki (HS-% ≥ 85 vähintään 8 tapolla tai vähintään 12 tappoa enintään 6 kierroksessa, 1 piste). Pisteet ja tasot ovat samat kuin muualla; perusteet avautuvat merkistä ja huomautus on *Perustuu ottelutallenteiden tilastoihin, ei todiste huijaamisesta.* Yksi piste yksin ei riitä Normaali-herkkyydellä (vain Tiukka näyttää sen).
- **Rainbow Six Siege, käsin syötetty**: **R6 > Pelaajan tarkistus** on tarkoitettu pelaajille, joita et ole nähnyt omissa tallenteissasi: syötät luvut käsin, jotka näet muualta: K/D, HS-%, voitto-%, ottelut, tapot, valinnaisesti tappoja/kierros, taso ja rank. Mukana on yksittäinen lomake ja 5 + 5 -lobby tiiviinä rivinä; viimeisimmät syötteet muistetaan. Säännöt: `R6_THRESHOLDS` (K/D ≥ 2,0 / 3,0 ja ≥ 50 ottelua, HS-% ≥ 60 / 75 ja ≥ 100 tappoa, voitto-% ≥ 75 ja ≥ 30 ottelua, tappoja/kierros ≥ 1,3, matala taso + Diamond+ rank).
- **Rainbow Six Siege, Arenyze-kausitilastoista**: kenelle tahansa haetulle pelaajalle (pelaajapaneeli, Live-pelin Ranked (Arenyze) -sarake, Pelaajan tarkistus > Hae Arenyzestä) sama `evaluateR6`-arvio kuin käsin syötetyssä tarkistuksessa, huomautuksella *Perustuu Ubisoftin kausitilastoihin (Arenyze), ei todiste huijaamisesta.* Ks. osio *R6-tilastot Arenyzestä*.
- **Rocket League**: ei luotettavaa ulkoista dataa, joten pelaajia ei merkitä.

## Pelaajaprofiilit, "Edellinen"-merkki ja automaattinen live-näkymä

- **Pelaajapaneeli**: klikkaa pelaajaa R6:n Live-pelissä, Ottelut-pistetaulussa tai Pelaajat-listassa, RL:n Live-pelissä, Historiassa tai Pelaajat-välilehdellä. Oikealta liukuva paneeli (ei erillinen ikkuna) näyttää kaiken, minkä sovellus on nähnyt pelaajasta: ottelut, K/D, HS-%, kanssa / vastaan (sinun V-H), parhaat operaattorit ja kartat (R6) tai keskiarvot per peli ja paras peli (RL), sekä **ottelulistan** (uusin ensin; päivä, kartta/areena, tila, kanssa/vastaan, tulos pelaajan näkökulmasta, tilastorivi). Ottelun klikkaus avaa koko pistetaulun, ja siitä pääsee toisen pelaajan paneeliin (**Takaisin** palaa; **Sulje** tai Esc sulkee). Overwatchissa lobbykortti ja haku avaavat OverFast-profiilin (**Takaisin lobbyyn** -painike), jonka lopussa on **Kohtaamiset**.
- **Tietojen rajat**: muiden pelaajien otteluista, joissa et ollut mukana, ei ole laillista lähdettä. R6:n ottelukohtainen data tulee vain omista tallenteistasi (kausitasoiset rank- ja K/D-tiedot mille tahansa pelaajalle saa valinnaisesti Arenyzestä, ks. oma osio), RL:n omista Stats API -tallenteistasi, ja Overwatchin julkinen profiili ei sisällä otteluhistoriaa lainkaan (näytetään uran tilastot ja omat kohtaamisesi). Siksi lista kattaa vain ottelut, joissa olet ollut mukana.
- **RL > Pelaajat**: kaikki tavatut pelaajat (avain PrimaryId, muuten nimi); haku ja lajittelu (pelit / kanssa / vastaan / viimeksi / nimi).
- **Edellinen-merkki**: nimen vieressä pieni merkki **Edellinen: kanssa** (turkoosi) tai **Edellinen: vastaan** (keltainen), jos pelaaja oli edellisessä ottelussasi (tooltipissä kartta/areena ja tulos). R6- ja RL-livenäkymässä sekä OW-lobbyssa; "Aiemmin"-sarake säilyy. R6 live: edellinen = uusin muu ottelu, jossa olit mukana. OW-lobbyssa edellinen on edellinen "Hae kaikki" -haku; sama kokoonpano uudelleen 5 min sisällä lasketaan samaksi lobbyksi (ei uudeksi istunnoksi).
- **OW-lobbyt**: jokainen "Hae kaikki" tallentuu tiedostoon `ow-lobbies.json` (aika, pelitila, alusta, oman tiimin ja vihollisten BattleTagit; enintään 500 istuntoa, vanhimmat pudotetaan). Profiilin **Kohtaamiset**-osio listaa lobbyt, joissa BattleTag on esiintynyt.
- **Peliprosessien tunnistus**: 5 s välein kevyt `tasklist`-kysely (ei ikkunoita, ei natiivimoduuleja): `RainbowSix.exe` / `RainbowSix_Vulkan.exe`, `Overwatch.exe`, `RocketLeague.exe`. Sivupalkin pelin piste on **vihreä**, kun ottelu on käynnissä, ja **keltainen**, kun peli on käynnissä mutta ottelua ei ole. RL: ottelu alkaa Stats API:n `MatchCreated`/`MatchInitialized`-viestistä heti. R6 kirjoittaa tallenteen vasta 1. kierroksen päätyttyä (noin 3–4 min ottelun alusta), joten Live-peli näyttää sitä ennen tekstin *Peli käynnissä – ottelun tiedot näkyvät 1. kierroksen jälkeen*; uusi Match-kansio merkitsee ottelun alkaneeksi. Overwatchissa ottelua ei voi tunnistaa: lobbyn yläreunassa on vain vihje *Overwatch käynnissä – liitä pelaajien nimet*.
- **Siirry live-näkymään automaattisesti** (Asetukset, oletuksena päällä): kun ottelu alkaa, näkymä vaihtuu kyseisen pelin Live-peliin ja näkyy pieni toast. Vaihto on vain sovelluksen sisäinen: ikkunaa ei tuoda eteen, aktivoida tai vilkuteta eikä Windows-ilmoituksia näytetä. Vaihtoa ei tehdä, kun kirjoitat lomakekenttään tai vahvistusikkuna / pelaajapaneeli on auki.

## Overwatch 2

- **Pelaajahaku**: kirjoita BattleTag (`Nimi#1234`), valitse pelitila (Kilpailullinen / Pikapeli) ja alusta (PC / Konsoli). Data tulee ilmaisesta OverFast API:sta (ei avainta).
- **Live-lobby**: kirjoita tai liitä oman tiimin ja vihollisten nimet käsin ("Liitä nimet" -kenttä, pilkku tai rivinvaihto erottimena) tai ota käyttöön Overwolf GEP (ks. oma osio): silloin lobby täyttyy ja haetaan automaattisesti ottelun alussa. "Hae kaikki" hakee pelaajat (enintään 3 rinnakkain) ja näyttää kortit sekä tiimien keskiarvot. Nimet muistetaan.
- Profiilin pitää olla **julkinen**, muuten tilastoja ei voi hakea.

## Rocket League

Sovellus käyttää pelin virallista paikallista **Stats API:a** (ei ulkoista palvelua).

1. Avaa **Asetukset**, paina **Etsi Rocket League** (tai **Valitse kansio**).
2. Paina **Ota käyttöön**. Sovellus kirjoittaa osioon `[TAGame.MatchStatsExporter_TA]` arvot `PacketSendRate=10`, `Port=49123` ja `WebPort=49124` (tiedosto `TAGame\Config\TAStatsAPI.ini` tai `DefaultStatsAPI.ini`) ja tekee ensin `.bak`-varmuuskopion.
3. Jos Windows estää kirjoituksen (esim. Program Files), sovellus näyttää ohjeet ja kopioitavan snippetin.
4. **Käynnistä Rocket League uudelleen.**
5. Aseta Asetuksissa **Oma nimi**, niin oma rivisi korostuu ja voitot lasketaan historiaan.

Näkymät: **Live-peli** (tulostaulu, tapahtumasyöte, Edellinen-merkit ja **Aiemmin**-sarake: montako peliä olet pelannut pelaajan kanssa / häntä vastaan (V-H sinun näkökulmastasi) sekä hänen keskiarvonsa omasta historiastasi: pisteet, maalit ja torjunnat per peli ja pelaajan oma voitto-%; käynnissä olevaa ottelua ei lasketa mukaan), **Historia** (koonnit ja ottelulista) ja **Pelaajat** (kaikki tavatut pelaajat; klikkaus avaa pelaajapaneelin).

## Rainbow Six Siege (Match Replay)

Rainbow Six Siegelle ei ole julkista tilasto-API:a, joten Statsikka lukee **pelin omat ottelutallenteet** (Match Replay). Tiedostoihin vain luetaan; pelikansioon ei kirjoiteta mitään.

1. Ota pelissä käyttöön **Match Replay** (Options → General → Match Replay; valikoiden nimet voivat vaihdella pelipäivitysten mukaan), jotta ottelut tallentuvat.
2. Statsikka löytää `MatchReplay`-kansion itse (Steam, Steam-kirjastot, Ubisoft Connect) tai voit valita sen **Asetukset > Rainbow Six Siege: ottelutallenteet > Valitse kansio**. Samassa kortissa näkyvät löydetty kansio, ottelumäärä ja viimeisin ottelu sekä **Skannaa uudelleen**. Ympäristömuuttujalla `R6_REPLAY_DIR` voi osoittaa kansion testejä varten.
3. Käynnistyksessä tallenteet luetaan taustalla (n. 1 s / ottelu; edistyminen näkyy), ja sen jälkeen uudet kierrokset luetaan automaattisesti.

Välilehdet:

- **Oma profiili**: voitot, häviöt, voitto-%, K/D, HS-%, tappoja/kierros, putki, 10 viimeisen voitto-%, hyökkäys- ja puolustuskierrosten voitto-%, ottelutyyppisuodatin (Kaikki / Ranked / Unranked / Quick), liukuva voitto-% ja K/D per ottelu -kaaviot, kartta- ja operaattoritaulukot sekä parhaat ottelut. Sinut tunnistetaan tallenteen omistajana (Ubisoft-profiilin tunniste), joten nimen ei tarvitse täsmätä; tyhjä Ubisoft-nimi täyttyy automaattisesti (ellet ole kirjautunut ulos). Sama osio näkyy sivupalkin Oma profiili -koosteessa.
- **Live-peli**: käynnissä oleva ottelu (tai teksti *Viimeisin ottelu*): kartta, tila, pistetilanne, pelatut kierrokset ja molempien tiimien pistetaulu (operaattorit, tapot, kuolemat, K/D, HS-%). Sarake **Aiemmin** kertoo, montako ottelua olet pelannut pelaajan kanssa / häntä vastaan (V-H sinun näkökulmastasi), hänen tilastonsa tallenteistasi ja epäilysmerkin. Näkymä päivittyy jokaisen kierroksen jälkeen; sivupalkin piste palaa, kun ottelu on käynnissä (ottelun katsotaan päättyneen, kun uusi ottelu alkaa tai tallenteet ovat olleet 3 min muuttumatta).
- **Ottelut**: ottelulista (uusin ensin) R6 Trackerin tapaan kortteina: vasemmassa reunassa tuloksen värinen palkki (voitto vihreä, tappio punainen, tasapeli / ei tulosta harmaa, käynnissä turkoosi), kartta, pelimuoto ja ottelutyyppi, aika, tulos kierroslukuineen (esim. "Voitto 4–2"), omat tapot/kuolemat, K/D, HS-%, KOST, entry ja clutch (kun laskettu) sekä operaattorit. Listan yläpuolella on yhteenveto näkyvistä otteluista (V–H, voitto-%, K/D ja RP yhteensä). Kortti aukeaa pistetauluksi ja kierroskohtaisiksi tuloksiksi. **RP-muutos** (esim. +23 RP / −19 RP, tooltipissa rank-pisteet ennen → jälkeen) tulee oman Arenyze-profiilin rank-pisteiden historiasta (`src/main/r6-rank.js`) ja näkyy vain, kun se voidaan laskea luotettavasti: Arenyze-avain on asetettu, Ubisoft-nimi tiedossa (alusta PC), ottelu on Ranked ja olit mukana, kahden peräkkäisen historiapisteen välillä on päättynyt täsmälleen yksi oma ranked-ottelu ja jälkimmäinen piste on enintään 3 h ottelun päättymisen jälkeen. Muuten chipiä ei näytetä (ei arvailua). Historia luetaan Arenyze-välimuistista; jos se puuttuu tai on yli 6 h vanha, Ottelut pyytää päivityksen taustalla samoilla säännöillä kuin automaattihaut (välimuisti, kuukauden pehmeä raja, automaattihaun kytkin; enintään kerran 10 min välein). Ottelun päättymisaika otetaan tallennekansion tiedostojen muokka-ajasta; tallenteen sisäinen aikaleima on paikallista aikaa merkittynä `Z`:lla, joten sitä ei tulkita UTC:nä.
- **Pelaajat**: kaikki tallenteissa tapaamasi pelaajat (haku, lajittelu, vain merkityt): K/D, HS-%, tappoja/kierros, ottelut kanssa ja vastaan, epäilysmerkki; pelaajan nimestä aukeaa tiedot ja ottelulista.
- **Pelaajan tarkistus**: käsin syötetty arvio pelaajille, joita et ole nähnyt tallenteissasi.

**Edistyneet kierrostilastot** (`src/main/r6-advanced.js`, laskettu tallenteen tappofeedistä; **Oma profiili**, pelaajapaneeli, **Pelaajat**-lista, **Ottelut**-pistetaulu ja **Live-peli** (vain tallenteesta, ei GEP:stä)). Tooltipit (hiiri ruudun päällä) selittävät mittarit; **epäilysarvio ei käytä näitä**. Määritelmät:
- **KOST %** = kierrokset, joilla pelaaja teki vihollistapon (**K**ill), hoiti objektiivin (**O**), selvisi hengissä (**S**) tai hänen kuolemansa tradattiin (**T**), jaettuna pelatuilla kierroksilla (ylipitkät kierrokset mukana).
- **Entry** = kierroksen ensimmäinen vihollistappo: entry-tapot–entry-kuolemat, onnistuminen = tapot / (tapot + kuolemat). Itsemurha ja tiimitappo eivät ole entry.
- **Trade** = tappo on trade-tappo, jos tapettu oli tappanut tappajan tiimikaverin enintään **10 s** aiemmin (`TRADE_WINDOW_S`, raja mukaan lukien); tiimikaverin kuolema on silloin **tradattu kuolema**. Trade-tappo lasketaan kerran tappoa kohti; asennuksen yli ei verrata kelloja (asennuksen jälkeen kello voi näyttää pommilaskuria).
- **Clutch 1vX** = pelaaja jää tiiminsä viimeiseksi eläväksi, kun X ≥ 1 vihollista on elossa (X rajataan 5:een); voitto = tiimi voittaa kierroksen. Johdetaan tappoaikajanasta, koska jäsentimen `1vX` kattaa vain voittajat ja menee väärin kierroksilla, joilla molemmat tiimit on merkitty voittajiksi. Voittaja päätellään pistetilanteesta (score > startingScore).
- **Multikillit** = kierrokset, joilla 2 / 3 / 4 / 5+ (ace) vihollistappoa. **Plantit / purut** = defuserin asennukset ja purut.
- Ohitetaan: TeamDeathmatch (ei pommikierroksia), kierros ilman Kill/Death/defuser-tapahtumia (puutteellinen tallenne) ja kierros ilman rosteria. Tiimitappo ei ole tappo (uhri silti kuolee), tuntematon tappaja ei saa tappoa eikä entryä.
- Tallennus: luvut tallentuvat pelaajakohtaisesti `r6-matches.json`:iin (`players[].adv`, skeema `v: 2`), joten ne säilyvät, vaikka peli poistaa tallennekansion. Vanhat tietueet jäsennetään taustalla uudelleen, jos kansio on vielä olemassa (Oma profiili näyttää etenemisen); jos kansio on jo poissa, luvut puuttuvat ja UI näyttää "–".
- Rajoitus: Y11S3-tallenteissa jäsennin ei tunnista defuserin asentajaa eikä purkajaa (Start-tapahtumia ei tule ja tekijäksi jää rosterin ensimmäinen pelaaja), joten plantit / purut jäävät 0:aan ja ruudun alla näkyy, montako kierrosta jäi ilman tunnistettua tekijää; objektiivi ei silloin lisää KOST:ia. Pelaajan poistuminen kesken kierroksen lasketaan selviytymiseksi.

Historia: tiivistelmät tallennetaan tiedostoon `r6-matches.json` (kansion nimi + tiedostojen aikaleimat/koot tunnisteena), joten seuraavat käynnistykset ovat nopeita eikä muuttumattomia otteluita jäsennetä uudelleen. **Peli säilyttää vain rajallisen määrän tallenteita ja poistaa vanhimmat, mutta Statsikan tallentamat yhteenvedot säilyvät**, joten historia kasvaa ajan mittaan. Nimen vaihtanut pelaaja yhdistetään Ubisoft-tunnisteella.

Rajoitukset: vain ne ottelut, jotka on tallennettu tälle koneelle ja kun Match Replay on ollut päällä; muiden pelaajien tilastot kattavat vain ottelut, joissa olet ollut mukana. Kartta- ja operaattorinimet näytetään sellaisina kuin jäsennin ne antaa (osa kartoista voi näkyä tunnisteena). Pisteet ja apu näytetään vain, jos ottelun tiedoissa on nollasta poikkeavia arvoja. Käynnissä oleva ottelu ei vielä kuulu omiin tilastoihin ennen kuin se on päättynyt. Käynnissä olevan ottelun tulos päivittyy kierros kerrallaan (kierros kirjoitetaan tallenteeseen vasta sen päätyttyä). Jäsennin on JS-portti ja sen kattavuus riippuu pelin tallenneformaatin versiosta; epäonnistuneet kierrokset ohitetaan (virhe näkyy asetuskortissa).

## R6-tilastot Arenyzestä (kenelle tahansa pelaajalle)

Pelin omat ottelutallenteet kertovat vain pelaajista, joiden kanssa olet pelannut. **Arenyze** (r6.arenyze.com) tarjoaa kehittäjärajapinnan, jolla saa minkä tahansa R6-pelaajan tilastot nimellä ja alustalla, myös pelaajille joiden kanssa et ole koskaan pelannut. Statsikka käyttää sitä **omalla API-avaimellasi**; ilman avainta mitään ei haeta eikä mikään muu toiminto muutu.

**Käyttöönotto** (kertaluonteinen):

1. Luo ilmainen tili osoitteessa [r6.arenyze.com](https://r6.arenyze.com/).
2. Avaa Dashboard → API key ja kopioi avain.
3. Avaa Statsikassa **Asetukset > R6-tilastot (Arenyze API)**, liitä avain kenttään ja paina **Testaa avain**. Testi kutsuu `GET /me/usage` -osoitetta; vasta onnistunut testi tallentaa avaimen.

**Mitä näkyy** (kaikki Ubisoftin kausitilastoja, ei ottelukohtaista historiaa):

- **Pelaajapaneeli** (klikkaa pelaajaa Live-pelissä, Pelaajat-listassa tai ottelun pistetaulussa): osio **Ubisoftin tilastot (Arenyze)**: rank ja rank-pisteet (RP), huipparank, kauden K/D, voitot–häviöt ja voitto-%, ottelut, HS-% (operaattoririveistä), tilin taso, **rank-pisteiden historia** -kaavio, parhaat operaattorit (ranked) ja kausitaulukko. Osiossa on hakuikä ("haettu 12 min sitten"), **Päivitä**-nappi ja alustavalinta (PC / PlayStation / Xbox). Pelaajat haetaan **nimellä + alustalla** (PC = `uplay`), koska profiilitunnisteella ei voi hakea. Osio toimii myös pelaajalle, jota ei ole nähty omissa tallenteissa.
- **Live-peli**: kun avain on asetettu ja automaattihaku on päällä, ottelun enintään 10 pelaajaa haetaan taustalla (GEP-rosterista tai käynnissä olevan ottelun tallenteesta). Pistetaulussa on sarake **Ranked (Arenyze)**: rank-merkki + RP, kauden K/D ja V–H sekä tarvittaessa epäilysmerkki. Rivin klikkaus avaa edelleen paneelin; tiedot tulevat välimuistista.
- **R6 > Pelaajan tarkistus**: **Hae Arenyzestä** täyttää lomakkeen (K/D, HS-%, voitto-%, ottelut, tapot, taso, rank) nimen ja alustan perusteella ja arvioi ne heti; **Tarkista** toimii samoilla luvuilla kuten ennenkin.
- **Oma profiili (R6)**: oma rank, RP ja rank-pisteiden historia asetusten Ubisoft-nimellä (`r6Name`).
- **Epätavalliset tilastot**: Arenyze-datasta lasketaan sama `evaluateR6`-arvio (samat rajat ja herkkyysasetus kuin käsin syötetyssä tarkistuksessa) normalisoidusta datasta: K/D, HS-%, voitto-%, ottelumäärä ja tilin taso + rank. Huomautus on *Perustuu Ubisoftin kausitilastoihin (Arenyze), ei todiste huijaamisesta.* Ottelutallenteista laskettu arvio säilyy rinnalla ja nimetään erikseen ("Ottelutallenteistasi:" / "Ubisoftin kausitilastoista (Arenyze):"). Otos on yhden kauden ranked-tilastot, joten alle 30 ottelulla arviota ei tehdä.

**Rajapinta ja kentät**: perusosoite `https://public-api.arenyze.com/r6/api` (dokumentaation toinen mainittu osoite `api.r6data.com` kuuluu vain vanhalle V1-rajapinnalle, joka vastaa 410 Gone, eikä sitä käytetä). Otsake `api-key: <avain>`. Käytetyt reitit: `GET /v2/fullstats?nameOnPlatform=&platformType=&modes=ranked` (rank, RP, huipparank, tapot/kuolemat, voitot/häviöt/keskeytykset, operaattorit, kaudet, taso `data.metadata.clearanceLevel`), `GET /v2/profile?nameOnPlatform=&platformType=` (taso, porttikielto, rank-pisteiden historia `history`, kaudet) ja `GET /v2/operators?...` (operaattorit, 24 h välimuisti), `GET /me/usage` (käyttö). Rank-nimi lasketaan rank-pisteistä (Rank 2.0: 100 RP / divisioona, Champion 4 500 RP:stä) tai, jos historian viimeinen piste täsmää, rank-pisteiden historian nimestä. Puuttuvat tai tuntemattomat kentät muuttuvat tyhjiksi (`–`), normalisointi ei kaadu.

**Kutsubudjetti** (ilmainen tili: 2 000 kutsua / kk, "fair usage", tarkoitettu testaukseen ja kevyeen henkilökohtaiseen käyttöön):

- **Välimuisti levylle** (`arenyze-cache.json`): yhteenveto ja profiili 6 h, operaattorit 24 h. Tuoretta tulosta ei haeta uudelleen (live-ottelun pelaajat haetaan kerran per pelaaja), samat haut yhdistetään ja rinnakkaisuus on enintään 2. Jos päivitys epäonnistuu, näytetään vanha tulos ikineen ja virheilmoituksella. **Päivitä** hakee uudelleen, mutta ei alle 30 s vanhaa tulosta.
- **Kuukausilaskuri** (UTC-kalenterikuukausi, tallentuu levylle): jokainen HTTP-yritys (myös 429-uusinta) lasketaan. Lisäksi `/me/usage` kertoo palvelimen lukeman (**Päivitä käyttö** -nappi ja Testaa avain); käytön arvio on suurempi näistä.
- **Pehmeä raja** (oletus 1 800 / kk, Asetukset): sen jälkeen **automaattiset haut loppuvat** (Live-peli, paneelin ja oman profiilin automaattinen lataus) ja vain käsin painetut **Päivitä** / **Hae Arenyzestä** hakevat. Raja 0 poistaa automaattihaut kokonaan; kytkin **Hae live-ottelun pelaajat automaattisesti** (oletus päällä, vain kun avain on asetettu) kytkee Live-pelin haut pois.
- **429**: Retry-After-ajan mukaan odotetaan ja yritetään kerran uudelleen (enintään 20 s); pidemmällä odotuksella automaattihaut pysähtyvät hetkeksi. Epäonnistunutta automaattihakua ei toisteta 5 min sisällä (pelaaja ei löydy: 30 min).

**Yksityisyys**: avain tallennetaan vain tälle koneelle salattuna (Electron safeStorage / Windows DPAPI, tiedosto `arenyze-key.bin`), kuten Overwolf-tunnukset; ilman salausta sitä ei tallenneta. Avain ei kulje asetusten eikä renderöijän kautta, sitä ei kirjata lokiin eikä lähetetä muualle kuin Arenyzelle `api-key`-otsakkeessa. **Pelaajien nimiä lähetetään Arenyzelle vain, kun pelaaja haetaan** (live-ottelun automaattihaku, paneeli, Pelaajan tarkistus). Linkki r6.arenyze.com avautuu oletusselaimeen vain klikatessa (vain https).

**Mitä tässä ei ole**: tracker.gg-tyyppistä **ottelukohtaista historiaa vieraista pelaajista** ei ole saatavilla, koska Arenyzen rajapinta ei tarjoa sitä (vain kausitasoiset tilastot ja rank-pisteiden historia), eikä Statsikka hae sitä mistään muualta (tracker.gg:n kaapimista ei toteuteta). Ottelukohtainen historia on edelleen vain omista tallenteistasi.

## Oma profiili

Sivupalkin ensimmäinen kohta ja sovelluksen aloitusnäkymä. Lisää omat tunnuksesi kohdassa **Asetukset > Omat profiilit**:

- **Overwatch 2**: BattleTag ja alusta (PC / Konsoli). **Tarkista**-nappi hakee profiilin ja näyttää nimen ja avatarin (tai virheen, jos profiilia ei löydy tai se on yksityinen).
- **Rocket League**: oma nimi (sama asetus kuin ennen, tunnistaa sinut live-taulukossa ja historiassa) ja alusta (vain tiedoksi).
- **Rainbow Six Siege**: Ubisoft-nimi (täyttyy automaattisesti ottelutallenteista, ks. yllä).

Näkymässä on osio jokaiselle pelille, jolle olet asettanut profiilin (muille kortti "Lisää oma profiili asetuksista").

**Overwatch 2** (OverFast API): nykyinen rankki roolia kohti ikoneineen ja seuraava rankki (esim. "Seuraava: Hopea 3"; ylin on Champion 1), kilpailulliset tilastot (voitot, häviöt, voitto-%, K/D, eniten tappoja pelissä, pelit), muutokset "Tällä viikolla / Tässä kuussa" sekä kaaviot rankista, voitto-%:sta ja K/D:stä. Sovellus tallentaa tilannekuvan käynnistyessä ja 30 minuutin välein sovelluksen ollessa auki, mutta vain jos jokin muuttui (enintään 2000 kuvaa, tiedosto `profile-history.json`). Kausi tallennetaan, ja kausivaihdokset näkyvät kaavioissa pystyviivoina.

**Rocket League** (paikallinen historia): voitot, häviöt, voitto-%, maalit ja torjunnat per peli, 10 viimeisen pelin voitto-%, nykyinen voitto-/tappioputki sekä liukuvat trendikaaviot (voitto-% ja maalit per peli).

**Rainbow Six Siege** (ottelutallenteet): omat tilastot, kaaviot, kartat ja operaattorit, ks. osio *Rainbow Six Siege (Match Replay)*.

### Rajoitukset

- **OW: rankin edistymisprosenttia ei saa automaattisesti.** Blizzardin julkinen profiili (ja siten OverFast) ei kerro sitä. Kirjaa prosentti käsin roolin kortista ("Edistyminen %", 0–100). Jokainen merkintä tallentuu aikaleimalla. Kun sinulla on vähintään kaksi merkintää samalta rankilta ja niiden välissä on pelattu pelejä (voitot ja tappiot luetaan automaattisista tilannekuvista), sovellus arvioi keskimääräisen edistymisen voittoa kohti ja näyttää "noin N voittoa seuraavaan rankiin (arvio)". Arvio olettaa, että voitto ja tappio liikuttavat yhtä paljon (lasketaan nettovoitoilla), joten se on vain suuntaa-antava. Muuten näytetään vain "X % jäljellä". Jos rankki vaihtuu merkinnän jälkeen, uusi merkintä pitää kirjata.
- **RL: Stats API ei kerro rankkia eikä MMR:ää.** Kirjaa rankki (Bronze I … Supersonic Legend), divisioona (I–IV) ja halutessasi MMR käsin pelilistakohtaisesti (Duel, Doubles, Standard, Muu). Kun annat myös "Seuraavan rajan MMR" (näet sen yhteisön sivustoilta), sovellus näyttää "+N MMR tarvitaan" ja arvion voitoista. MMR/voitto johdetaan omista MMR-merkinnöistäsi ja paikallisen historian voitoista ja tappioista merkintöjen välillä; jos se ei onnistu, käytetään 9 MMR/voitto ja arvio merkitään näkyviin. Sovellus ei sisällä kovakoodattua MMR-rajataulukkoa, koska rajat muuttuvat kausittain.
- OW-tilannekuvia kertyy vain, kun sovellus on auki. BattleTagin tai alustan vaihto nollaa OW-kehityshistorian (sovellus kysyy vahvistuksen).

## Testaus ilman peliä

```
npm run mock-rl
```

Käynnistää simuloidun 3v3-pelin osoitteeseen `ws://127.0.0.1:49130` (portin voi vaihtaa ympäristömuuttujalla `MOCK_RL_PORT`; oletus ei ole pelin 49124, jottei käynnissä oleva Statsikka tallenna testiotteluita historiaan). Savutesti (`npm run smoke`) käyttää automaattisesti porttia 49130 (tai `MOCK_RL_PORT`) omissa asetuksissaan, joten mock käynnistetään ilman porttimuuttujaa: `node scripts/mock-rl.js`. Käsin testatessa vaihda Asetuksissa WebSocket-portiksi 49130. Mukana pelaaja "Akseli". Käynnistä sovellus toisessa terminaalissa. Logiikkatestit: `node scripts/selftest.js`. Edistyneiden R6-tilastojen oikean datan tarkistus (vain luku): `node scripts/r6-advanced-check.js [--dir <MatchReplay>] [--id <profileID>] [--verbose]` tulostaa KOST-%, entry-, trade-, clutch-, multikill- ja plant/defuse-luvut sekä invarianttitarkistukset. Näkymätön savutesti (ei avaa ikkunaa, käyttää omaa tietokansiota `%TEMP%\statsikka-smoke`, ei koske leikepöytään): `npm run smoke` (= `node scripts/start.js --smoke-test`; ow-electronilla tai varalla tavallisella Electronilla). Taustatila testataan näkymättömästi: ikkunan näyttö (`showInactive`, kohdistus), Tray ja Windows-käynnistys ovat savutestissä kirjaavia tekaistuja toteutuksia (oikeaa kuvaketta tai rekisterimerkintää ei tehdä); `--hidden`-polku: `node_modules\electron\dist\electron.exe . --smoke-test --hidden`. Savutesti käy läpi kaikki näkymät, välilehdet ja lomakkeet, tarkistaa asettelun koossa 1280×800 ja 1000×680 sekä tulostaa jokaisesta tarkistuksesta `ok` / `FAIL`. Keinotekoiset epäilyttävät profiilit ovat vain savutestin koukuissa (`--smoke-test`), eivät muualla. Arenyze-osuus: logiikkatestit (`scripts/selftest-arenyze.js`) käyttävät fixtureja kansiossa `test/arenyze/` (rakennettu r6.arenyze.com/api-docs -sivun esimerkkivastauksista), feikkiä fetchiä, feikkiä safeStorage-toteutusta ja hallittua kelloa; savutesti (`src/main/smoke-arenyze.js`) korvaa pääprosessin fetchin stubilla, joka palauttaa samat fixturet, eikä Arenyzeen tehdä testeissä oikeita verkkokutsuja (avaimeton tila: mitään ei haeta; avaimen kanssa paneeli, live-rivit, budjetti, Pelaajan tarkistus ja asetuskortti). R6-osuus: savutesti kopioi 3 uusinta ottelukansiota koneen oikeasta MatchReplay-kansiosta (vain luetaan) kansioon `%TEMP%\statsikka-r6-smoke`, käy läpi R6-välilehdet oikealla datalla ja simuloi käynnissä olevan ottelun kopioimalla kierrostiedostoja uuteen kansioon siellä; jos tallenteita ei ole koneella, R6-tarkistukset ohitetaan. Oikean datan kertaluonteinen tarkistus: aseta `ST_R6_REAL=1` ja `R6_REPLAY_DIR=<MatchReplay>` ennen `--smoke-test`iä (tulostaa luvut ja lopettaa).

## Rajoitukset

- Ilman Overwolf GEP:iä OW:n live-lobby on manuaalinen, eikä Overwatchin ottelun alkua voi tunnistaa automaattisesti (vain että peli on käynnissä). GEP vaatii oman Overwolf-kehittäjäavaimen ja ow-electron-ajon; tarkka GEP-viestien muoto (esim. R6:n pelaajakohtaiset terveys-/tappopäivitykset) varmistuu vasta oikeassa pelissä, ja Asetusten diagnostiikka näyttää saapuneet viestit.
- Muiden pelaajien otteluhistoriaa ei ole saatavilla: paneelit näyttävät vain sen, mitä omat tallenteesi ja lobbyistuntosi sisältävät.
- Profiilin pitää olla julkinen.
- RL-historia kertyy vain, kun sovellus on auki pelin aikana.
- Rainbow Six Siege: ottelukohtainen data tulee vain omista ottelutallenteista (Match Replay pitää olla päällä pelissä), ks. osio *Rainbow Six Siege (Match Replay)*. Vieraiden pelaajien rank ja kausitilastot saa valinnaisesti Arenyzestä (oma API-avain, 2 000 kutsua / kk ilmaisella tilillä), mutta **tracker.gg-tyyppistä ottelukohtaista historiaa vieraista pelaajista ei ole saatavilla**, ks. osio *R6-tilastot Arenyzestä*.

## Asetukset

**Tausta ja käynnistys** (toimi taustalla, avaa pelin käynnistyessä, käynnistä Windowsin mukana), omat profiilit (kaikki pelit), OW:n oletusalusta ja -pelitila, epätavallisten tilastojen herkkyys, RL:n WebSocket-portti ja Stats API -käyttöönotto, R6:n tallennekansio (**Valitse kansio**, **Skannaa uudelleen**, tila), **R6-tilastot (Arenyze API)** (avain salattuna, Testaa avain, käyttö tässä kuussa ja palvelimen lukema, pehmeä raja, automaattihaun kytkin, välimuistin tyhjennys), **Overwolf (live-pelitiedot)** (tunnus, GEP dev -kanava, tila, diagnostiikka), **Tyhjennä välimuisti** (HTTP), **Nollaa OW-profiilin historia**, **Tyhjennä RL-otteluhistoria** (vahvistuksella) sekä sovelluksen versio ja tietojen sijainti. Asetukset validoidaan tiukasti pääprosessissa: virheelliset arvot ja tuntemattomat avaimet hylätään.

## Tiedot

Asetukset ja historia tallentuvat kansioon `%APPDATA%\statsikka` (`settings.json`, `rl-matches.json`, `profile-history.json`, `r6-matches.json`, `ow-lobbies.json`, `ow-credentials.bin` salattu Overwolf-tunnus, `arenyze-key.bin` salattu Arenyze-avain, `arenyze-cache.json` Arenyze-välimuisti ja kuukausilaskuri).

Näkymätön savutesti voi tallentaa kuvakaappauksia: aseta `ST_SHOTS=<kansio>` (esim. `own-profile`, `settings`).
