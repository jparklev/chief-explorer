import React, { Component } from 'react';
import './App.css';
import web3, { initWeb3 } from './web3';
import ReactNotify from './notify';
import { etherscanTx } from './helpers';

var dschief = require('./config/dschief.json');
var dstoken = require('./config/dstoken.json');
var chiefContract = web3.eth.contract(dschief.abi);
var tokenContract = web3.eth.contract(dstoken.abi);
window.dschief = dschief;
window.dstoken = dstoken;
window.chiefContract = chiefContract;
window.tokenContract = tokenContract;
window.l = console.log;

class App extends Component {
  state = {
    gov: null,
    iou: null,
    chief: null,
    slates: [],
    candidates: {},
    myVote: null,
    GOVBalance: web3.toBigNumber(-1),
    GOVLocked: web3.toBigNumber(-1),
    hat: null,
    account: null,
    transactions: {},
    network: {
    },
  }

  checkNetwork = () => {
    web3.version.getNode((error) => {
      const isConnected = !error;

      // Check if we are synced
      if (isConnected) {
        web3.eth.getBlock('latest', (e, res) => {
          if (typeof(res) === 'undefined') {
            console.debug('YIKES! getBlock returned undefined!');
          }
          if (res.number >= this.state.network.latestBlock) {
            const networkState = { ...this.state.network };
            networkState['latestBlock'] = res.number;
            networkState['outOfSync'] = e != null || ((new Date().getTime() / 1000) - res.timestamp) > 600;
            this.setState({ network: networkState });
          } else {
            // XXX MetaMask frequently returns old blocks
            // https://github.com/MetaMask/metamask-plugin/issues/504
            console.debug('Skipping old block');
          }
        });
      }

      // Check which network are we connected to
      // https://github.com/ethereum/meteor-dapp-wallet/blob/90ad8148d042ef7c28610115e97acfa6449442e3/app/client/lib/ethereum/walletInterface.js#L32-L46
      if (this.state.network.isConnected !== isConnected) {
        if (isConnected === true) {
          web3.eth.getBlock(0, (e, res) => {
            let network = false;
            if (!e) {
              switch (res.hash) {
                case '0xa3c565fc15c7478862d50ccd6561e3c06b24cc509bf388941c25ea985ce32cb9':
                  network = 'kovan';
                  break;
                case '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3':
                  network = 'main';
                  break;
                default:
                  console.log('setting network to private');
                  console.log('res.hash:', res.hash);
                  network = 'private';
              }
            }
            if (this.state.network.network !== network) {
              this.initNetwork(network);
            }
          });
        } else {
          const networkState = { ...this.state.network };
          networkState['isConnected'] = isConnected;
          networkState['network'] = false;
          networkState['latestBlock'] = 0;
          this.setState({ network: networkState });
        }
      }
    });
  }

  initNetwork = (newNetwork) => {
    //checkAccounts();
    const networkState = { ...this.state.network };
    networkState['network'] = newNetwork;
    networkState['isConnected'] = true;
    networkState['latestBlock'] = 0;
    this.setState({ network: networkState });

    this.initContract();
  }

  checkAccounts = () => {
    web3.eth.getAccounts((error, accounts) => {
      if (!error) {
        const networkState = { ...this.state.network };
        networkState['accounts'] = accounts;
        networkState['defaultAccount'] = accounts[0];
        web3.eth.defaultAccount = networkState['defaultAccount'];
        this.setState({ network: networkState }, () => {
          if (web3.isAddress(this.state.network.defaultAccount)) {
            web3.eth.getBalance(this.state.network.defaultAccount, (e, r) => {
              const networkState = { ...this.state.network };
              networkState['accountBalance'] = r;
              this.setState({ network: networkState });
            });
          }
        });
      }
    });
  }

  componentDidMount() {
    setTimeout(() => {
      initWeb3(web3);
      window.web3 = web3;
      this.checkNetwork();
      this.checkAccounts();
      this.checkAccountsInterval = setInterval(this.checkAccounts, 10000);
      this.checkNetworkInterval = setInterval(this.checkNetwork, 3000);
    }, 500);
  }

  initContract = () => {
    const gov = window.localStorage.getItem('gov');
    const iou = window.localStorage.getItem('iou');
    const chief = window.localStorage.getItem('chief');
    window.chiefObj = this.chiefObj = chiefContract.at(chief);
    window.govObj = this.govObj = tokenContract.at(gov);
    window.iouObj = this.iouObj = tokenContract.at(iou);
    if (gov && iou && chief && web3.isAddress(gov) && web3.isAddress(iou) && web3.isAddress(chief)) {
      this.getGOVBalance();
      this.getGOVAllowance();
      this.getGOVLocked();
      this.getMyVote();
      this.getHat();
      this.setState({ gov, iou, chief }, () => {
        this.chiefObj.LogNote({ sig: [this.methodSig('etch(address[])'), this.methodSig('vote(address[])'), this.methodSig('vote(address[],address)')] }, { fromBlock: 0 }, (e, r) => {
          if (!e) {
            const addressesString = r.args.fax.substring(r.args.sig === this.methodSig('vote(address[],address)') ? 202 : 138);
            this.setState((prevState, props) => {
              const candidates = {...prevState.candidates};
              const slates = {...prevState.slates};
              const addresses = [];
              let slateHashAddress = '';
              for (let i = 0; i < addressesString.length / 64; i++) {
                const address = `0x${addressesString.substring(i * 64 + 24, (i + 1) * 64)}`;
                candidates[address] = typeof candidates[address] !== 'undefined' ? candidates[address] : web3.toBigNumber(0);
                addresses.push(address);
                slateHashAddress += addressesString.substring(i * 64, (i + 1) * 64);
              }
              slates[web3.sha3(slateHashAddress, { encoding: 'hex' })] = addresses;
              return { candidates, slates };
            }, () => {
              this.getApprovals();
            });
          }
        });
      });
      this.chiefObj.LogNote({ sig: this.methodSig('lift(address)') }, { fromBlock: 'latest' }, (e, r) => {
        this.getHat();
        this.logTransactionConfirmed(r.transactionHash);
      });
      this.chiefObj.LogNote({ sig: this.methodSig('vote(bytes32)') }, { fromBlock: 'latest' }, (e, r) => {
        this.getMyVote();
        this.getApprovals();
        this.logTransactionConfirmed(r.transactionHash);
      });
      this.chiefObj.LogNote({ sig: [this.methodSig('lock(uint128)'), this.methodSig('free(uint128)')] }, { fromBlock: 'latest' }, (e, r) => {
        this.getGOVLocked();
        this.getApprovals();
      });
      this.govObj.LogNote({ sig: [this.methodSig('transfer(address,uint256)'),
                                  this.methodSig('transferFrom(address,address,uint256)'),
                                  this.methodSig('push(address,uint128)'),
                                  this.methodSig('pull(address,uint128)'),
                                  this.methodSig('mint(uint128)'),
                                  this.methodSig('burn(uint128)')] }, { fromBlock: 'latest' }, (e, r) => {
        this.getGOVBalance();
        this.getGOVAllowance();
        this.logTransactionConfirmed(r.transactionHash);
      });
      this.govObj.LogNote({ sig: this.methodSig('approve(address,uint256)') }, { fromBlock: 'latest' }, (e, r) => {
        this.getGOVAllowance();
        this.logTransactionConfirmed(r.transactionHash);
      });
      // This is necessary to finish transactions that failed after signing
      this.checkPendingTransactionsInterval = setInterval(this.checkPendingTransactions, 10000);
    }
  }

  methodSig = (method) => {
    return web3.sha3(method).substring(0, 10)
  }

  // Transactions
  checkPendingTransactions = () => {
    const transactions = { ...this.state.transactions };
    Object.keys(transactions).map(tx => {
      if (transactions[tx].pending) {
        web3.eth.getTransactionReceipt(tx, (e, r) => {
          if (!e && r !== null) {
            if (r.logs.length === 0) {
              this.logTransactionFailed(tx);
            } else if (r.blockNumber)  {
              this.logTransactionConfirmed(tx);
            }
          }
        });
      }
      return false;
    });
  }

  logPendingTransaction = (tx, title, callback = {}) => {
    const msgTemp = 'Transaction TX was created. Waiting for confirmation...';
    const transactions = { ...this.state.transactions };
    transactions[tx] = { pending: true, title, callback }
    this.setState({ transactions });
    console.log(msgTemp.replace('TX', tx))
    this.refs.notificator.info(tx, title, etherscanTx(this.state.network.network, msgTemp.replace('TX', `${tx.substring(0,10)}...`), tx), false);
  }

  logTransactionConfirmed = (tx) => {
    const msgTemp = 'Transaction TX was confirmed.';
    const transactions = { ...this.state.transactions };
    if (transactions[tx]) {
      transactions[tx].pending = false;
      this.setState({ transactions });

      this.refs.notificator.success(tx, transactions[tx].title, etherscanTx(this.state.network.network, msgTemp.replace('TX', `${tx.substring(0,10)}...`), tx), 4000);
    }
  }

  logTransactionFailed = (tx) => {
    const msgTemp = 'Transaction TX failed.';
    const transactions = { ...this.state.transactions };
    if (transactions[tx]) {
      transactions[tx].pending = false;
      this.setState({ transactions });
      this.refs.notificator.error(tx, transactions[tx].title, msgTemp.replace('TX', `${tx.substring(0,10)}...`), 4000);
    }
  }
  //

  getApprovals = () => {
    Object.keys(this.state.candidates).map(key => {
      this.chiefObj.approvals(key, (e2, r2) => {
        if (!e2) {
          this.setState((prevState, props) => {
            const candidates = {...prevState.candidates};
            candidates[key] = r2;
            return { candidates };
          });
        }
      });
      return false;
    });
  }

  getGOVBalance = () => {
    this.govObj.balanceOf(this.state.network.defaultAccount, (e, r) => {
      if (!e) {
        this.setState({ GOVBalance: r })
      }
    });
  }

  getGOVAllowance = () => {
    this.govObj.allowance(this.state.network.defaultAccount, this.chiefObj.address, (e, r) => {
      if (!e) {
        this.setState({ GOVAllowance: r })
      }
    });
  }

  getGOVLocked = () => {
    this.chiefObj.deposits(this.state.network.defaultAccount, (e, r) => {
      if (!e) {
        this.setState({ GOVLocked: r })
      }
    });
  }

  getMyVote = () => {
    this.chiefObj.votes(this.state.network.defaultAccount, (e, r) => {
      if (!e) {
        this.setState({ myVote: r })
      }
    });
  }

  getHat = () => {
    this.chiefObj.hat((e, r) => {
      if (!e) {
        this.setState({ hat: r })
      }
    });
  }

  deploy = async (e) => {
    e.preventDefault();
    if (this.max_yays.value) {
      try {
        const gov = await this.deployToken('0x474f560000000000000000000000000000000000000000000000000000000000'); // symbol = GOV
        console.log('GOV:', gov);
        const iou = await this.deployToken('0x494f550000000000000000000000000000000000000000000000000000000000'); // symbol = IOU
        console.log('IOU:', iou);
        const chief = await this.deployChief(gov, iou, this.max_yays.value);
        console.log('Chief:', chief);
        if (gov && iou && chief && web3.isAddress(gov) && web3.isAddress(iou) && web3.isAddress(chief)) {
          this.setOwnership(iou, chief);
          window.localStorage.setItem('gov', gov);
          window.localStorage.setItem('iou', iou);
          window.localStorage.setItem('chief', chief);
          window.chiefObj = this.chiefObj = chiefContract.at(chief);
          window.govObj = this.govObj = tokenContract.at(gov);
          window.iouObj = this.iouObj = tokenContract.at(iou);
          this.setState({ gov, iou, chief });
        }
      } catch (e) {
        console.log(e);
      }
    }
  }

  doDeploy = (max_yays) => {
    return Promise.resolve(this.deployToken());
  }

  checkDeployedAddress = (resolve, reject, error, tx) => {
    if (!error && tx) {
      web3.eth.getTransactionReceipt(tx.transactionHash, (err, res) => {
        if (!err) {
          if (res && res.contractAddress) {
            resolve(res.contractAddress);
          }
        } else {
          reject(err);
        }
      });
    } else {
      reject(error);
    }
  }

  deployToken = (symbol) => {
    return new Promise((resolve, reject) => {
      tokenContract.new(symbol, { data: dstoken.bytecode, gas: 2000000 }, (error, tx) => {
        this.checkDeployedAddress(resolve, reject, error, tx);
      });
    })
  }

  deployChief = (gov, iou, max) => {
    return new Promise((resolve, reject) => {
      chiefContract.new(gov, iou, max, { data: dschief.bytecode, gas: 2000000 }, (error, tx) => {
        this.checkDeployedAddress(resolve, reject, error, tx);
      });
    })
  }

  setOwnership = (iou, chief) => {
    return new Promise((resolve, reject) => {
      tokenContract.at(iou).setOwner(chief, (error, tx) => {
        if (!error) {
          resolve(tx);
        } else {
          reject(error);
        }
      });
    })
  }

  lockFree = (e) => {
    e.preventDefault();
    const method = this.methodLF.value;
    this.chiefObj[method](web3.toWei(this.amount.value), (e, tx) => {
      this.logPendingTransaction(tx, `${method}: ${this.amount.value}`);
    });
    return false;
  }

  voteSlate = (e) => {
    e.preventDefault();
    const slate = e.target.getAttribute('data-slate');
    this.chiefObj.vote.bytes32(slate, (e, tx) => {
      this.logPendingTransaction(tx, `vote: ${slate}`);
    });
    return false;
  }

  createSlate = (e) => {
    e.preventDefault();
    const method = this.methodVE.value;
    const addresses = this.addresses.value.replace(/\s/g,'').split(',').sort();
    this.chiefObj[method]['address[]'](addresses, (e, tx) => {
      this.logPendingTransaction(tx, `${method}: ${addresses.join(',')}`);
    });
    return false;
  }

  liftCandidate = (e) => {
    e.preventDefault();
    const address = e.target.getAttribute('data-address');
    this.chiefObj.lift(address, (e, tx) => {
      this.logPendingTransaction(tx, `lift: ${address}`);
    });
    return false;
  }

  render() {
    return (
      <div className="App">
        <h2>DS Chief</h2>
        <p>Your account: { this.state.network.defaultAccount }</p>
        <p>Create new set of contracts</p>
        <form ref={input => this.deployForm = input} onSubmit={e => this.deploy(e)}>
          <input ref={input => this.max_yays = input} name="max_yays" type="number" /> Max Yays
          <button onClick={this.deploy}>Deploy</button>
        </form>
        <p>Actual contracts:</p>
        <p>Gov: { this.state.gov }</p>
        <p>Iou: { this.state.iou }</p>
        <p>Chief: { this.state.chief }</p>
        <br />
        <p>GOV Balance: { web3.fromWei(this.state.GOVBalance).valueOf() }</p>
        <p>GOV Allowance: { web3.fromWei(this.state.GOVAllowance).valueOf() }</p>
        <p>GOV Locked: { web3.fromWei(this.state.GOVLocked).valueOf() }</p>
        <br />
        <form ref={(input) => this.lockFreeForm = input} onSubmit={(e) => this.lockFree(e)}>
          <p>Lock/Free GOV</p>
          <input ref={(input) => this.amount = input} type="number" placeholder="Amount to be locked/freed" style={ {width: '200px'} }/>
          <select ref={(input) => this.methodLF = input} >
            <option value="lock">Lock</option>
            <option value="free">Free</option>
          </select>
          <input type="submit" />
        </form>
        <br />
        <p>Hat: { this.state.hat }</p>
        <br />
        <p>Slates Created:</p>
        <table>
          <thead>
            <tr>
              <th>
                Slate
              </th>
              <th>
                Addresses
              </th>
              <th>
              </th>
            </tr>
          </thead>
          <tbody>
            {
              Object.keys(this.state.slates).map(key =>
                <tr key={ key }>
                  <td>
                    { key.substring(0,10) }...
                  </td>
                  <td>
                    {
                      this.state.slates[key].map(value => <p key={ value }>{ value }</p>)
                    }
                  </td>
                  <td>
                    {
                      this.state.myVote === key
                      ? 'Voted'
                      : <a data-slate={ key } href="#vote" onClick={ this.voteSlate }>Vote this</a>
                    }
                  </td>
                </tr>
              )
            }
          </tbody>
        </table>
        <br />
        <form ref={(input) => this.createSlateForm = input} onSubmit={(e) => this.createSlate(e)}>
          <p>New slate</p>
          <input ref={(input) => this.addresses = input} type="text" placeholder="Add addresses (comma separated)" style={ {width: '200px'} }/>
          <select ref={(input) => this.methodVE = input} >
            <option value="vote">Create and vote</option>
            <option value="etch">Just create</option>
          </select>
          <input type="submit" />
        </form>
        <br />
        <p>Candidates Ranking:</p>
        <table>
          <thead>
            <tr>
              <th>
                Candidate
              </th>
              <th>
                Weight
              </th>
              <th>
              </th>
            </tr>
          </thead>
          <tbody>
          {
            Object.keys(this.state.candidates).map(key =>
              <tr key={ key }>
                <td>{ key }</td>
                <td>{ web3.fromWei(this.state.candidates[key]).valueOf() }</td>
                <td>{ this.state.candidates[key] > this.state.candidates[this.state.hat] ? <a href="#lift" data-address={ key } onClick={ this.liftCandidate }>Lift this candidate</a> : '' }</td>
              </tr>
            )
          }
          </tbody>
        </table>
        <ReactNotify ref='notificator'/>
      </div>
    );
  }
}

export default App;
