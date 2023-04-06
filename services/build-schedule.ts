import {NUM_OF_CHANNELS, START_CHANNEL} from './channels';
import {db, IDocument} from './database';
import {useLinear} from './networks';
import {IChannel, IEntry, ILinearChannel} from './shared-interfaces';

const scheduleEntry = async (entry: IEntry & IDocument, startChannel: number): Promise<void> => {
  const availableChannels = await db.schedule.find<IChannel>({endsAt: {$lt: entry.start}}).sort({channel: 1});

  if (!availableChannels || !availableChannels.length) {
    const channelNums = await db.schedule.count({});

    if (channelNums > NUM_OF_CHANNELS - 1) {
      return;
    }

    const newChannelNum = channelNums + startChannel;

    await db.schedule.insert<IChannel>({
      channel: newChannelNum,
      endsAt: entry.end,
    });

    await db.entries.update<IEntry>({_id: entry._id}, {$set: {channel: newChannelNum}});
  } else {
    await db.schedule.update<IChannel>({_id: availableChannels[0]._id}, {$set: {endsAt: entry.end}});
    await db.entries.update<IEntry>({_id: entry._id}, {$set: {channel: availableChannels[0].channel}});
  }
};

export const scheduleEntries = async (firstRun = true): Promise<void> => {
  let needReschedule = false;

  if (useLinear) {
    // eslint-disable-next-line object-shorthand
    await db.entries.update<IEntry>(
      {
        $where () {
          return this.from !== 'mlbtv' && this.network !== 'ESPN+';
        },
      },
      {$unset: {channel: true}},
      {multi: true},
    );
  }

  const unscheduledEntries = await db.entries.find<IEntry>({channel: {$exists: false}}).sort({start: 1});

  // eslint-disable-next-line object-shorthand
  const unscheduledRegularEntries = await db.entries.count({
    $and: [
      {
        $where () {
          return this.from === 'mlbtv' || this.network === 'ESPN+';
        },
      },
      {channel: {$exists: false}},
    ],
  });

  unscheduledRegularEntries &&
    console.log(`Scheduling ${useLinear ? unscheduledRegularEntries : unscheduledEntries.length} entries...`);

  for (const entry of unscheduledEntries) {
    if (!useLinear) {
      await scheduleEntry(entry, START_CHANNEL);
    } else {
      // Normal entries
      if (entry.from === 'mlbtv' || entry.network === 'ESPN+') {
        const linearChannelNums = await db.linear.count({});
        await scheduleEntry(entry, linearChannelNums + START_CHANNEL);
        // Linear entries
      } else {
        const exisingLinearChannel = await db.linear.findOne<ILinearChannel>({name: entry.network});

        if (!exisingLinearChannel) {
          needReschedule = true;

          const linearChannelNums = await db.linear.count({});

          await db.linear.insert<ILinearChannel>({
            channel: linearChannelNums,
            name: entry.network,
          });
        }
      }
    }
  }

  if (useLinear) {
    if (firstRun) {
      if (needReschedule) {
        console.log('***************************************************************************');
        console.log('**                                                                       **');
        console.log('** Need to rebuild the schedule because the USE_LINEAR variable was used **');
        console.log('**                     or networks have been changed                     **');
        console.log('**                                                                       **');
        console.log('***************************************************************************');
        console.log('**       THIS WILL BREAK SCHEDULED RECORDINGS IN YOUR DVR SOFTWARE       **');
        console.log('***************************************************************************');

        await db.entries.update<IEntry>({}, {$unset: {channel: true}}, {multi: true});
        await db.schedule.remove({}, {multi: true});

        return await scheduleEntries();
      }

      const unscheduledLinearEntries = await db.entries.find<IEntry>({channel: {$exists: false}}).sort({start: 1});

      for (const entry of unscheduledLinearEntries) {
        const exisingLinearChannel = await db.linear.findOne<ILinearChannel>({name: entry.network});

        if (!exisingLinearChannel) {
          continue;
        }

        const channelNum = exisingLinearChannel.channel + START_CHANNEL;

        await db.entries.update<IEntry>({_id: entry._id}, {$set: {channel: channelNum}});
        await db.schedule.insert<IChannel>({
          channel: channelNum,
          endsAt: entry.end,
        });
      }
    } else {
      console.log('***************************************************************************');
      console.log('**                                                                       **');
      console.log('** There are new events from linear channels. Please restart the service **');
      console.log('**                       to schedule these events!                       **');
      console.log('**                                                                       **');
      console.log('***************************************************************************');
    }
  }
};
