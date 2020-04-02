const Apify = require('apify');
const extractNumbers = require('extract-numbers');

const LATEST = 'LATEST';
const parseNum = (str) => {
    return parseInt(extractNumbers(str)[0].replace('.', ''), 10);
};
const MAIN_STATS = 'MAIN_STATS';
const HOSPITALIZATION = 'HOSPITALIZATION';

const getNameAndValue = (str) => {
    console.log(str);
    const split = str.split(' (');
    return { name: split[0].trim(), value: parseNum(split[1].replace(')', '').trim(), 10) };
};
const processInfoString = (str) => {
    const split = str.split(',');
    const info = [];
    split.forEach((region) => {
        const regionString = region.replace('nach Bundesländern:', '').trim();
        if (regionString.includes('und')) {
            const [first, second] = regionString.split('und');
            info.push(getNameAndValue(first));
            info.push(getNameAndValue(second));
        } else {
            info.push(getNameAndValue(regionString));
        }
    });
    return info;
};
const extractDataFromParagraph = (paragraphText) => {
    const re = new RegExp(String.fromCharCode(160), 'g');
    const split = paragraphText.replace(re, ' ').split(': ');
    const introSplit = split[0].split(', ');
    const dateSplit = introSplit[1].replace('Stand ', '').split('.');
    const date = new Date(`${dateSplit[1]}/${dateSplit[0]}/${dateSplit[2]} ${introSplit[2].split(' Uhr')[0]}`);
    console.log(introSplit, '');
    return {
        total: parseNum(extractNumbers(split[1])[0]),
        byRegion: split[2] && processInfoString(split[2]),
        date: new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours() - 2, date.getMinutes())),

    };
};
Apify.main(async () => {
    const kvStore = await Apify.openKeyValueStore('COVID-19-AUSTRIA');
    const dataset = await Apify.openDataset('COVID-19-AUSTRIA-HISTORY');

    const requestQueue = await Apify.openRequestQueue();
    await requestQueue.addRequest({
        url: 'http://web.archive.org/web/20200318180034/https://www.sozialministerium.at/Informationen-zum-Coronavirus/Neuartiges-Coronavirus-(2019-nCov).html',
        userData: {
            label: MAIN_STATS,
        },
    });

    const crawler = new Apify.CheerioCrawler({
        requestQueue,
        handlePageFunction: async ({ request, $ }) => {
            const { label, data = {}, shouldScrapeHospitalized } = request.userData;

            switch (label) {
                case MAIN_STATS:
                    const confirmedCasesParagraph = $('p:contains(Bestätigte Fälle)').last().text();
                    const deathsParagraph = $('p:contains(Todesfälle)').last().text();
                    const recoveredParagraph = $('p:contains(Genesen)').last().text();
                    const testedParagraph = $('p:contains(Bisher durchgeführte Testungen in Österreich)').last().text();

                    const extratedInfected = extractDataFromParagraph(confirmedCasesParagraph);
                    const extratedDeaths = extractDataFromParagraph(deathsParagraph);
                    console.log(recoveredParagraph ? 'Prdel' : 'NE', 'REC', testedParagraph);
                    const recovered = recoveredParagraph && parseNum(recoveredParagraph.split(': ')[1].trim());
                    const tested = parseNum(testedParagraph.split(': ')[1].trim());

                    data.infected = extratedInfected.total;
                    data.infectedByRegion = extratedInfected.byRegion;
                    data.deceased = extratedDeaths.total;
                    data.deceasedByRegion = extratedDeaths.byRegion;
                    data.recovered = recovered;
                    data.tested = tested;
                    data.source = request.url;
                    try {
                        data.lastudpatedAtSource = extratedInfected.date.toISOString();
                    } catch (e) {
                        console.log(extratedInfected.date);
                    }

                    await requestQueue.addRequest({
                        url: request.url.replace('https://www.sozialministerium.at/Informationen-zum-Coronavirus/Neuartiges-Coronavirus-(2019-nCov).html', 'https://www.sozialministerium.at/Informationen-zum-Coronavirus/Dashboard/Zahlen-zur-Hospitalisierung'),
                        userData: {
                            label: HOSPITALIZATION,
                            data,
                            shouldScrapeHospitalized: new Date('03/26/2020 00:00') < extratedInfected.date,
                        },
                    });
                    const nextDayLink = $('#displayDayEl').next().find('a').attr('href');

                    if (nextDayLink) {
                        await requestQueue.addRequest({
                            url: nextDayLink,
                            userData: {
                                label: MAIN_STATS,

                            },
                        });
                    }
                    break;
                case HOSPITALIZATION:
                    const tableData = [];
                    if (shouldScrapeHospitalized) {
                        console.log(shouldScrapeHospitalized, data.lastudpatedAtSource);
                        $('table.table tbody tr').each((index, element) => {
                            tableData.push({
                                region: $(element).find('td').eq(0).text(),
                                icu: parseNum($(element).find('td').eq(2).text()),
                                hospitalized: parseNum($(element).find('td').eq(1).text()),
                            });
                        });
                        tableData.splice(tableData.length - 1, 1);
                    }
                    data.hospitalizationData = tableData;
                    data.totalIcu = tableData.reduce((total, val) => total + val.icu, 0);
                    data.totalHospitalized = tableData.reduce((total, val) => total + val.hospitalized, 0);
                    const now = new Date();
                    data.lastUpdatedAtApify = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes())).toISOString();
                    console.log(data);

                    await Apify.pushData(data);
                    break;

                default:
                    break;
            }
        },
        handleFailedRequestFunction: async ({ request }) => {
            await Apify.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
            });
        },
    });
    await crawler.run();


    console.log('Done.');
});
