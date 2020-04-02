const Apify = require('apify');
const extractNumbers = require('extract-numbers');

const LATEST = 'LATEST';
const parseNum = (str) => {
    return parseInt(extractNumbers(str)[0].replace('.', ''), 10);
};
const MAIN_STATS = 'MAIN_STATS';
const HOSPITALIZATION = 'HOSPITALIZATION';

const getNameAndValue = (str) => {
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
    const split = paragraphText.split(': ');
    return {
        total: parseNum(extractNumbers(split[1])[0]),
        byRegion: processInfoString(split[2]),
    };
};
Apify.main(async () => {
    const kvStore = await Apify.openKeyValueStore('COVID-19-AUSTRIA');
    const dataset = await Apify.openDataset('COVID-19-AUSTRIA-HISTORY');

    const requestQueue = await Apify.openRequestQueue();
    await requestQueue.addRequest({
        url: 'https://www.sozialministerium.at/Informationen-zum-Coronavirus/Neuartiges-Coronavirus-(2019-nCov).html',
        userData: {
            label: MAIN_STATS,
        },
    });

    await requestQueue.addRequest({
        url: 'https://www.sozialministerium.at/Informationen-zum-Coronavirus/Dashboard/Zahlen-zur-Hospitalisierung',
        userData: {
            label: HOSPITALIZATION,
        },
    });
    const data = {};

    const crawler = new Apify.CheerioCrawler({
        requestQueue,
        handlePageFunction: async ({ request, $ }) => {
            const { label } = request.userData;

            switch (label) {
                case MAIN_STATS:
                    const confirmedCasesParagraph = $('p:contains(Bestätigte Fälle)').text();
                    const deathsParagraph = $('p:contains(Todesfälle)').text();
                    const recoveredParagraph = $('p:contains(Genesen)').text();
                    const testedParagraph = $('p:contains(Bisher durchgeführte Testungen in Österreich)').text();

                    const extratedInfected = extractDataFromParagraph(confirmedCasesParagraph);
                    const extratedDeaths = extractDataFromParagraph(deathsParagraph);
                    const recovered = parseNum(recoveredParagraph.split(': ')[1].trim());
                    const tested = parseNum(testedParagraph.split(': ')[1].trim());

                    data.infected = extratedInfected.total;
                    data.infectedByRegion = extratedInfected.byRegion;
                    data.deceased = extratedDeaths.total;
                    data.deceasedByRegion = extratedDeaths.byRegion;
                    data.recovered = recovered;
                    data.tested = tested;
                    break;
                case HOSPITALIZATION:
                    const tableData = [];
                    $('table tbody tr').each((index, element) => {
                        tableData.push({
                            region: $(element).find('td').eq(0).text(),
                            icu: parseNum($(element).find('td').eq(2).text()),
                            hospitalized: parseNum($(element).find('td').eq(1).text()),
                        });
                    });
                    data.hospitalizationData = tableData;
                    data.totalIcu = tableData.reduce((total, val) => total + val.icu, 0) / 2;
                    data.totalHospitalized = tableData.reduce((total, val) => total + val.hospitalized, 0) / 2;

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
    console.log(data);

    let latest = await kvStore.getValue(LATEST);
    if (!latest) {
        await kvStore.setValue('LATEST', data);
        latest = data;
    }
    delete latest.lastUpdatedAtApify;
    const actual = Object.assign({}, data);
    delete actual.lastUpdatedAtApify;

    if (JSON.stringify(latest) !== JSON.stringify(actual)) {
        await dataset.pushData(data);
    }

    await kvStore.setValue('LATEST', data);
    await Apify.pushData(data);

    console.log('Done.');
});
