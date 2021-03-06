/**
 * @license
 * Copyright 2018 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import * as tf from '@tensorflow/tfjs';

import {Example, SerializedExamples} from './types';

/**
 * Generate a pseudo-random UID.
 */
function getUID(): string {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
  }
  return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() +
      s4() + s4();
}

/**
 * A serializable, mutable set of speech/audio `Example`s;
 */
export class Dataset {
  private examples: {[id: string]: Example};
  private label2Ids: {[label: string]: string[]};

  /**
   * Constructor of `Dataset`.
   *
   * If called with no arguments (i.e., `artifacts` == null), an empty dataset
   * will be constructed.
   *
   * Else, the dataset will be deserialized from `artifacts`.
   *
   * @param artifacts Optional serialization artifacts to deserialize.
   */
  constructor(artifacts?: SerializedExamples) {
    if (artifacts == null) {
      this.examples = {};
      this.label2Ids = {};
    } else {
      // TODO(cais): Implement deserialization.
      throw new Error('Deserialization is not implemented yet');
    }
  }

  /**
   * Add an `Example` to the `Dataset`
   *
   * @param example A `Example`, with a label. The label must be a non-empty
   *   string.
   * @returns The UID for the added `Example`.
   */
  addExample(example: Example): string {
    tf.util.assert(example != null, 'Got null or undefined example');
    tf.util.assert(
        example.label != null && example.label.length > 0,
        `Expected label to be a non-empty string, ` +
            `but got ${JSON.stringify(example.label)}`);
    const uid = getUID();
    this.examples[uid] = example;
    if (!(example.label in this.label2Ids)) {
      this.label2Ids[example.label] = [];
    }
    this.label2Ids[example.label].push(uid);
    return uid;
  }

  /**
   * Get a map from `Example` label to number of `Example`s with the label.
   *
   * @returns A map from label to number of example counts under that label.
   */
  getExampleCounts(): {[label: string]: number} {
    const counts: {[label: string]: number} = {};
    for (const uid in this.examples) {
      const example = this.examples[uid];
      if (!(example.label in counts)) {
        counts[example.label] = 0;
      }
      counts[example.label]++;
    }
    return counts;
  }

  /**
   * Get all examples of a given label, with their UIDs.
   *
   * @param label The requested label.
   * @return All examples of the given `label`, along with their UIDs.
   *   The examples are sorted in the order in which they are added to the
   *   `Dataset`.
   * @throws Error if label is `null` or `undefined`.
   */
  getExamples(label: string): Array<{uid: string, example: Example}> {
    tf.util.assert(
        label != null,
        `Expected label to be a string, but got ${JSON.stringify(label)}`);
    tf.util.assert(
        label in this.label2Ids,
        `No example of label "${label}" exists in dataset`);
    const output: Array<{uid: string, example: Example}> = [];
    this.label2Ids[label].forEach(id => {
      output.push({uid: id, example: this.examples[id]});
    });
    return output;
  }

  /**
   * Get all examples and labels as tensors.
   *
   * - If `label` is provided and exists in the vocabulary of the `Dataset`,
   *   the spectrograms of all `Example`s under the `label` will be returned
   *   as a 4D `tf.Tensor` as `xs`. The shape of the `tf.Tensor` will be
   *     `[numExamples, numFrames, frameSize, 1]`
   *   where
   *     - `numExamples` is the number of `Example`s with the label
   *     - `numFrames` is the number of frames in each spectrogram
   *     - `frameSize` is the size of each spectrogram frame.
   *   No label Tensor will be returned.
   * - If `label` is not provided, all `Example`s will be returned as `xs`.
   *   In addition, `ys` will contain a one-hot encoded list of labels.
   *   - The shape of `xs` will be: `[numExamples, numFrames, frameSize, 1]`
   *   - The shape of `ys` will be: `[numExamples, vocabularySize]`.
   *
   * @returns `xs` and `ys` tensors. See description above.
   * @throws Error
   *   - if not all the involved spectrograms have matching `numFrames` and
   *     `frameSize`, or
   *   - if `label` is provided and is not present in the vocabulary of the
   *     `Dataset`, or
   *   - if the `Dataset` is currently empty.
   */
  getSpectrogramsAsTensors(label?: string):
      {xs: tf.Tensor4D, ys?: tf.Tensor2D} {
    tf.util.assert(
        this.size() > 0,
        `Cannot get spectrograms as tensors because the dataset is empty`);
    const vocab = this.getVocabulary();
    if (label != null) {
      tf.util.assert(
          vocab.indexOf(label) !== -1,
          `Label ${label} is not in the vocabulary ` +
          `(${JSON.stringify(vocab)})`);
    } else {
      // If all words are requested, there must be at least two words in the
      // vocabulary to make one-hot encoding possible.
      tf.util.assert(
          vocab.length > 1,
          `One-hot encoding of labels requires the vocabulary to have ` +
          `at least two words, but it has only ${vocab.length } word.`);
    }
 
    return tf.tidy(() => {
      const xTensors: tf.Tensor3D[] = [];
      const labelIndices: number[] = [];
      let uniqueNumFrames: number;
      let uniqueFrameSize: number;
      for (let i = 0; i < vocab.length; ++i) {
        const currentLabel = vocab[i];
        if (label != null && label !== currentLabel) {
          continue;
        }
        const ids = this.label2Ids[currentLabel];
        for (const id of ids) {
          const spectrogram = this.examples[id].spectrogram;
          const frameSize = spectrogram.frameSize;
          const numFrames = spectrogram.data.length / frameSize;
          if (uniqueNumFrames == null) {
            uniqueNumFrames = numFrames;
          } else {
            tf.util.assert(
                numFrames === uniqueNumFrames,
                `Mismatch in numFrames (${numFrames} vs ${uniqueNumFrames})`);
          }
          if (uniqueFrameSize == null) {
            uniqueFrameSize = frameSize;
          } else {
            tf.util.assert(
                frameSize === uniqueFrameSize,
                `Mismatch in frameSize  ` +
                    `(${frameSize} vs ${uniqueFrameSize})`);
          }
          xTensors.push(
              tf.tensor3d(spectrogram.data, [numFrames, frameSize, 1]));
          if (label == null) {
            labelIndices.push(i);
          }
        }
      }
      return {
        xs: tf.stack(xTensors) as tf.Tensor4D,
        ys: label == null ?
            tf.oneHot(tf.tensor1d(labelIndices, 'int32'), vocab.length)
                .asType('float32') :
            undefined
      };
    });
  }

  /**
   * Remove an example from the `Dataset`.
   *
   * @param uid The UID of the example to remove.
   * @throws Error if the UID doesn't exist in the `Dataset`.
   */
  removeExample(uid: string): void {
    if (!(uid in this.examples)) {
      throw new Error(`Nonexistent example UID: ${uid}`);
    }
    const label = this.examples[uid].label;
    delete this.examples[uid];
    const index = this.label2Ids[label].indexOf(uid);
    this.label2Ids[label].splice(index, 1);
    if (this.label2Ids[label].length === 0) {
      delete this.label2Ids[label];
    }
  }

  /**
   * Get the total number of `Example` currently held by the `Dataset`.
   *
   * @returns Total `Example` count.
   */
  size(): number {
    return Object.keys(this.examples).length;
  }

  /**
   * Query whether the `Dataset` is currently empty.
   *
   * I.e., holds zero examples.
   *
   * @returns Whether the `Dataset` is currently empty.
   */
  empty(): boolean {
    return this.size() === 0;
  }

  /**
   * Remove all `Example`s from the `Dataset`.
   */
  clear(): void {
    this.examples = {};
  }

  /**
   * Get the list of labels among all `Example`s the `Dataset` currently holds.
   *
   * @returns A sorted Array of labels, for the unique labels that belong to all
   *   `Example`s currently held by the `Dataset`.
   */
  getVocabulary(): string[] {
    const vocab = new Set<string>();
    for (const uid in this.examples) {
      const example = this.examples[uid];
      vocab.add(example.label);
    }
    const sortedVocab = [...vocab];
    sortedVocab.sort();
    return sortedVocab;
  }

  /**
   * Serialize the `Dataset`
   *
   * @returns A `SerializedDataset` object amenable to transmission and storage.
   */
  serialize(): SerializedExamples {
    // TOOD(cais): Implement serialization.
    throw new Error('Dataset.serialize() is not implemented yet.');
  }
}
