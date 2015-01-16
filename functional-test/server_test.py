import unittest
from state_machine_crawler import State, Transition, StateMachineCrawler
from subprocess import Popen, PIPE, STDOUT
import sys
import os
import requests

class CommandExecutionError(Exception):
    pass

def call(*command):
    process = Popen(command, shell=True, stdout=PIPE, stderr=STDOUT)

    outputs = []

    # Poll process for new output until finished
    while True:
        nextline = process.stdout.readline()
        if nextline == '' and process.poll() is not None:
            break
        sys.stdout.write(nextline)
        outputs.append(nextline)
        sys.stdout.flush()

    output = "\n".join(outputs)
    exitCode = process.returncode

    if exitCode == 0:
        return output
    else:
        raise CommandExecutionError(command, exitCode, output)


class InstalledState(State):

    def verify(self):
        if not os.path.exists("/tmp/lokki.port"):
            return False
        with open("/tmp/lokki.port") as fil:
            port = fil.read()
        response = requests.get("http://localhost:" + port)
        return response.status_code == 200

class InitialTransition(Transition):
    target_state = InstalledState

    def move(self):
        cmd = "bash " + os.path.abspath(os.path.dirname(__file__)) + "/init.sh"

        call(cmd)

class BaseTest(unittest.TestCase):

    def setUp(self):
        self.cr = StateMachineCrawler(requests, InitialTransition)


    def test_foo(self):
        self.cr.move(InstalledState)
        self.assertIs(self.cr.state, InstalledState)
