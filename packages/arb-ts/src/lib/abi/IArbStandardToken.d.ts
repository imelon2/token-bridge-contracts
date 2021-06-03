/* Autogenerated file. Do not edit manually. */
/* tslint:disable */
/* eslint-disable */

import {
  ethers,
  EventFilter,
  Signer,
  BigNumber,
  BigNumberish,
  PopulatedTransaction,
} from 'ethers'
import {
  Contract,
  ContractTransaction,
  Overrides,
  CallOverrides,
} from '@ethersproject/contracts'
import { BytesLike } from '@ethersproject/bytes'
import { Listener, Provider } from '@ethersproject/providers'
import { FunctionFragment, EventFragment, Result } from '@ethersproject/abi'

interface IArbStandardTokenInterface extends ethers.utils.Interface {
  functions: {
    'bridgeBurn(address,uint256)': FunctionFragment
    'bridgeInit(address,bytes)': FunctionFragment
    'bridgeMint(address,uint256)': FunctionFragment
    'l1Address()': FunctionFragment
    'migrate(address,uint256)': FunctionFragment
  }

  encodeFunctionData(
    functionFragment: 'bridgeBurn',
    values: [string, BigNumberish]
  ): string
  encodeFunctionData(
    functionFragment: 'bridgeInit',
    values: [string, BytesLike]
  ): string
  encodeFunctionData(
    functionFragment: 'bridgeMint',
    values: [string, BigNumberish]
  ): string
  encodeFunctionData(functionFragment: 'l1Address', values?: undefined): string
  encodeFunctionData(
    functionFragment: 'migrate',
    values: [string, BigNumberish]
  ): string

  decodeFunctionResult(functionFragment: 'bridgeBurn', data: BytesLike): Result
  decodeFunctionResult(functionFragment: 'bridgeInit', data: BytesLike): Result
  decodeFunctionResult(functionFragment: 'bridgeMint', data: BytesLike): Result
  decodeFunctionResult(functionFragment: 'l1Address', data: BytesLike): Result
  decodeFunctionResult(functionFragment: 'migrate', data: BytesLike): Result

  events: {}
}

export class IArbStandardToken extends Contract {
  connect(signerOrProvider: Signer | Provider | string): this
  attach(addressOrName: string): this
  deployed(): Promise<this>

  on(event: EventFilter | string, listener: Listener): this
  once(event: EventFilter | string, listener: Listener): this
  addListener(eventName: EventFilter | string, listener: Listener): this
  removeAllListeners(eventName: EventFilter | string): this
  removeListener(eventName: any, listener: Listener): this

  interface: IArbStandardTokenInterface

  functions: {
    bridgeBurn(
      account: string,
      amount: BigNumberish,
      overrides?: Overrides
    ): Promise<ContractTransaction>

    'bridgeBurn(address,uint256)'(
      account: string,
      amount: BigNumberish,
      overrides?: Overrides
    ): Promise<ContractTransaction>

    bridgeInit(
      _l1Address: string,
      _data: BytesLike,
      overrides?: Overrides
    ): Promise<ContractTransaction>

    'bridgeInit(address,bytes)'(
      _l1Address: string,
      _data: BytesLike,
      overrides?: Overrides
    ): Promise<ContractTransaction>

    bridgeMint(
      account: string,
      amount: BigNumberish,
      overrides?: Overrides
    ): Promise<ContractTransaction>

    'bridgeMint(address,uint256)'(
      account: string,
      amount: BigNumberish,
      overrides?: Overrides
    ): Promise<ContractTransaction>

    l1Address(overrides?: CallOverrides): Promise<[string]>

    'l1Address()'(overrides?: CallOverrides): Promise<[string]>

    migrate(
      destination: string,
      amount: BigNumberish,
      overrides?: Overrides
    ): Promise<ContractTransaction>

    'migrate(address,uint256)'(
      destination: string,
      amount: BigNumberish,
      overrides?: Overrides
    ): Promise<ContractTransaction>
  }

  bridgeBurn(
    account: string,
    amount: BigNumberish,
    overrides?: Overrides
  ): Promise<ContractTransaction>

  'bridgeBurn(address,uint256)'(
    account: string,
    amount: BigNumberish,
    overrides?: Overrides
  ): Promise<ContractTransaction>

  bridgeInit(
    _l1Address: string,
    _data: BytesLike,
    overrides?: Overrides
  ): Promise<ContractTransaction>

  'bridgeInit(address,bytes)'(
    _l1Address: string,
    _data: BytesLike,
    overrides?: Overrides
  ): Promise<ContractTransaction>

  bridgeMint(
    account: string,
    amount: BigNumberish,
    overrides?: Overrides
  ): Promise<ContractTransaction>

  'bridgeMint(address,uint256)'(
    account: string,
    amount: BigNumberish,
    overrides?: Overrides
  ): Promise<ContractTransaction>

  l1Address(overrides?: CallOverrides): Promise<string>

  'l1Address()'(overrides?: CallOverrides): Promise<string>

  migrate(
    destination: string,
    amount: BigNumberish,
    overrides?: Overrides
  ): Promise<ContractTransaction>

  'migrate(address,uint256)'(
    destination: string,
    amount: BigNumberish,
    overrides?: Overrides
  ): Promise<ContractTransaction>

  callStatic: {
    bridgeBurn(
      account: string,
      amount: BigNumberish,
      overrides?: CallOverrides
    ): Promise<void>

    'bridgeBurn(address,uint256)'(
      account: string,
      amount: BigNumberish,
      overrides?: CallOverrides
    ): Promise<void>

    bridgeInit(
      _l1Address: string,
      _data: BytesLike,
      overrides?: CallOverrides
    ): Promise<void>

    'bridgeInit(address,bytes)'(
      _l1Address: string,
      _data: BytesLike,
      overrides?: CallOverrides
    ): Promise<void>

    bridgeMint(
      account: string,
      amount: BigNumberish,
      overrides?: CallOverrides
    ): Promise<void>

    'bridgeMint(address,uint256)'(
      account: string,
      amount: BigNumberish,
      overrides?: CallOverrides
    ): Promise<void>

    l1Address(overrides?: CallOverrides): Promise<string>

    'l1Address()'(overrides?: CallOverrides): Promise<string>

    migrate(
      destination: string,
      amount: BigNumberish,
      overrides?: CallOverrides
    ): Promise<void>

    'migrate(address,uint256)'(
      destination: string,
      amount: BigNumberish,
      overrides?: CallOverrides
    ): Promise<void>
  }

  filters: {}

  estimateGas: {
    bridgeBurn(
      account: string,
      amount: BigNumberish,
      overrides?: Overrides
    ): Promise<BigNumber>

    'bridgeBurn(address,uint256)'(
      account: string,
      amount: BigNumberish,
      overrides?: Overrides
    ): Promise<BigNumber>

    bridgeInit(
      _l1Address: string,
      _data: BytesLike,
      overrides?: Overrides
    ): Promise<BigNumber>

    'bridgeInit(address,bytes)'(
      _l1Address: string,
      _data: BytesLike,
      overrides?: Overrides
    ): Promise<BigNumber>

    bridgeMint(
      account: string,
      amount: BigNumberish,
      overrides?: Overrides
    ): Promise<BigNumber>

    'bridgeMint(address,uint256)'(
      account: string,
      amount: BigNumberish,
      overrides?: Overrides
    ): Promise<BigNumber>

    l1Address(overrides?: CallOverrides): Promise<BigNumber>

    'l1Address()'(overrides?: CallOverrides): Promise<BigNumber>

    migrate(
      destination: string,
      amount: BigNumberish,
      overrides?: Overrides
    ): Promise<BigNumber>

    'migrate(address,uint256)'(
      destination: string,
      amount: BigNumberish,
      overrides?: Overrides
    ): Promise<BigNumber>
  }

  populateTransaction: {
    bridgeBurn(
      account: string,
      amount: BigNumberish,
      overrides?: Overrides
    ): Promise<PopulatedTransaction>

    'bridgeBurn(address,uint256)'(
      account: string,
      amount: BigNumberish,
      overrides?: Overrides
    ): Promise<PopulatedTransaction>

    bridgeInit(
      _l1Address: string,
      _data: BytesLike,
      overrides?: Overrides
    ): Promise<PopulatedTransaction>

    'bridgeInit(address,bytes)'(
      _l1Address: string,
      _data: BytesLike,
      overrides?: Overrides
    ): Promise<PopulatedTransaction>

    bridgeMint(
      account: string,
      amount: BigNumberish,
      overrides?: Overrides
    ): Promise<PopulatedTransaction>

    'bridgeMint(address,uint256)'(
      account: string,
      amount: BigNumberish,
      overrides?: Overrides
    ): Promise<PopulatedTransaction>

    l1Address(overrides?: CallOverrides): Promise<PopulatedTransaction>

    'l1Address()'(overrides?: CallOverrides): Promise<PopulatedTransaction>

    migrate(
      destination: string,
      amount: BigNumberish,
      overrides?: Overrides
    ): Promise<PopulatedTransaction>

    'migrate(address,uint256)'(
      destination: string,
      amount: BigNumberish,
      overrides?: Overrides
    ): Promise<PopulatedTransaction>
  }
}
