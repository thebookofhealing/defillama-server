import dynamodb from "../utils/shared/dynamodb";
import { Protocol } from "../protocols/data";
import { getDay, getTimestampAtStartOfDay, secondsInDay } from "../utils/date";
import { TokensValueLocked, tvlsObject } from "../types";
import getTVLOfRecordClosestToTimestamp from "../utils/shared/getRecordClosestToTimestamp";
import { sendMessage } from "../utils/discord";

type PKconverted = (id: string) => string;

export default async (
  protocol: Protocol,
  unixTimestamp: number,
  tvl: tvlsObject<TokensValueLocked>,
  hourlyTvl: PKconverted,
  dailyTvl: PKconverted
) => {
  const hourlyPK = hourlyTvl(protocol.id);
  if (Object.keys(tvl).length === 0) {
    return;
  }

  await dynamodb.put({
    PK: hourlyPK,
    SK: unixTimestamp,
    ...tvl
  });

  const closestDailyRecord = await getTVLOfRecordClosestToTimestamp(
    dailyTvl(protocol.id),
    unixTimestamp,
    secondsInDay * 1.5
  );

  if (hourlyPK.includes("hourlyUsdTokensTvl"))
    await checkForOutlierCoins(tvl, closestDailyRecord, protocol.name);

  if (getDay(closestDailyRecord?.SK) !== getDay(unixTimestamp)) {
    // First write of the day
    await dynamodb.put({
      PK: dailyTvl(protocol.id),
      SK: getTimestampAtStartOfDay(unixTimestamp),
      ...tvl
    });
  }
};
async function checkForOutlierCoins(
  currentTvls: tvlsObject<TokensValueLocked>,
  previousTvls: tvlsObject<TokensValueLocked>,
  protocol: string
) {
  const changeThresholdFactor = 4;
  const proportionThresholdFactor = 0.5;
  const headline = `${protocol} has TVL values out of accepted range:\n`;
  let alertString = headline;

  Object.keys(currentTvls).map((tvlKey) => {
    const totalChainTvlPrevious = Object.values(previousTvls[tvlKey] ?? {}).reduce(
      (p: number, c: number) => p + c,
      0
    );

    Object.keys(currentTvls[tvlKey]).map((coinKey) => {
      const currentCoinValue = currentTvls[tvlKey][coinKey];
      if (!(tvlKey in previousTvls)) return;
      if (!(coinKey in previousTvls[tvlKey])) return;

      const previousCoinValue = previousTvls[tvlKey][coinKey];
      const changeUpperBound = previousCoinValue * changeThresholdFactor;
      const changeLowerBound = previousCoinValue / changeThresholdFactor;

      const proportionBoundPrevious =
        totalChainTvlPrevious * proportionThresholdFactor;

      if (
        currentCoinValue > proportionBoundPrevious &&
        (currentCoinValue > changeUpperBound ||
          currentCoinValue < changeLowerBound)
      )
        alertString += `${coinKey.toUpperCase()} on ${tvlKey} with previous of ${previousCoinValue} and current of ${currentCoinValue}, `;
    });
  });

  if (alertString != headline)
    await sendMessage(
      alertString,
      process.env.STALE_COINS_ADAPTERS_WEBHOOK!,
      true
    );
}
